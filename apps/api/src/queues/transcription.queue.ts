import { Worker, type Job } from 'bullmq';
import {
  QUEUE_NAMES,
  getWorkerOptions,
  type TranscriptionJobData,
  type TranscriptionResult,
  type DebriefJobData,
} from './config.js';
import { getPresignedDownloadUrl } from '../lib/storage.js';
import { transcribe, getTranscriptionProvider } from '../lib/ai/index.js';
import type { TranscriptionOptions } from '../lib/ai/transcription/types.js';
import { diarizeAudio, type DiarizationResult } from '../lib/ai/diarization.js';
import { db } from '../lib/db.js';
import { transcriptionQueue, debriefQueue } from './queues.js';
import { maybeEnqueueSessionDebrief } from './session-debrief.queue.js';
import { incrementAudioMinutes } from '../lib/subscription.js';
import { getEnv } from '../lib/env.js';
import {
  withTempSplitUrlToWav16kMonoChunks,
  withTempTranscodeToWav16kMono,
} from '../lib/audio/ffmpeg.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import fetch from 'node-fetch';

// Re-export queue for convenience
export { transcriptionQueue };

// ============================================
// Types
// ============================================

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

interface DiarizationSegment {
  start: number;
  end: number;
  speaker: string;
  text?: string;
}

/** Apply YOU/OTHER labels from diarization onto transcript segments. */
function applyDiarizationLabels(
  transcriptionResult: { text: string; segments?: WhisperSegment[] },
  diarizationSegments: DiarizationSegment[]
): WhisperSegment[] {
  if (diarizationSegments.length === 0) return transcriptionResult.segments ?? [];

  if (transcriptionResult.segments && transcriptionResult.segments.length > 0) {
    return transcriptionResult.segments.map((tSeg, i) => {
      const dSeg = diarizationSegments[i];
      return {
        ...tSeg,
        speaker: dSeg?.speaker || 'speaker_0',
      };
    });
  }

  // On-device transcripts have text but no Whisper timestamps. Build segments
  // from diarization timings so YOU/OTHER labels are persisted and shown in UI.
  return diarizationSegments.map((seg, _index, arr) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text?.trim() || (arr.length === 1 ? transcriptionResult.text : ''),
    speaker: seg.speaker,
  }));
}

/** Prefix lines with speaker labels for debrief + readable transcript text. */
function formatLabeledTranscriptText(segments: WhisperSegment[]): string {
  return segments
    .filter((seg) => seg.text.trim().length > 0)
    .map((seg) => `${seg.speaker}: ${seg.text.trim()}`)
    .join('\n');
}

const LONG_RECORDING_FILE_SIZE_BYTES = 75 * 1024 * 1024;
const TRANSCRIPTION_CHUNK_SECONDS = 10 * 60; // 10-min WAV chunks = 19.2 MB, safely under Whisper's 25 MB limit
const MAX_DIARIZATION_DURATION_SEC = 90 * 60;

function getCloudTranscriptionOptions(env: ReturnType<typeof getEnv>) {
  return {
    punctuate: true,
    diarize: false as const,
    ...(env.TRANSCRIPTION_LANGUAGE ? { language: env.TRANSCRIPTION_LANGUAGE } : {}),
  };
}

// ============================================
// Worker
// ============================================

let transcriptionWorker: Worker<TranscriptionJobData, TranscriptionResult> | null = null;

export function startTranscriptionWorker(): Worker<
  TranscriptionJobData,
  TranscriptionResult
> | null {
  if (!transcriptionQueue) return null;
  if (transcriptionWorker) {
    return transcriptionWorker;
  }

  transcriptionWorker = new Worker<TranscriptionJobData, TranscriptionResult>(
    QUEUE_NAMES.TRANSCRIPTION,
    async (job: Job<TranscriptionJobData, TranscriptionResult>) => {
      const { recordingId, jobId, objectKey, mimeType, userId } = job.data;
      const log = (msg: string) => console.log(`[Transcription:${job.id}] ${msg}`);

      try {
        log(`Starting transcription for recording ${recordingId}`);

        // Step 1: Update job status to running
        await updateJobStatus(jobId, 'running');
        await job.updateProgress(10);

        // Step 2: Get presigned download URL
        log('Getting download URL from S3');
        const { downloadUrl } = await getPresignedDownloadUrl(objectKey);
        await job.updateProgress(20);

        // Step 3a: Cost-floor short-circuit. If the client (iOS SFSpeechRecognizer)
        // already wrote a Transcript row during completeUpload, use it directly
        // and skip the Whisper API call entirely. This is the structural cost
        // reduction — every minute transcribed on-device is a minute we don't
        // pay for. Empty/missing transcripts fall through to the cloud path.
        const env = getEnv();
        const transcriptionOptions = getCloudTranscriptionOptions(env);

        const existingTranscript = env.USE_CLIENT_TRANSCRIPT
          ? await db.transcript.findUnique({
              where: { recordingId },
              select: { text: true, language: true },
            })
          : null;

        const providerName = getTranscriptionProvider().name;
        const normalizedMime = mimeType.split(';')[0]?.trim().toLowerCase();

        let transcriptionResult: {
          text: string;
          segments?: Array<{
            start: number;
            end: number;
            text: string;
            speaker?: string;
            confidence?: number;
          }>;
          language: string;
          duration?: number;
          metadata?: Record<string, unknown>;
        };

        if (existingTranscript?.text && existingTranscript.text.trim().length > 0) {
          log('Using client-provided transcript — skipping cloud STT');
          transcriptionResult = {
            text: existingTranscript.text,
            segments: [],
            language: existingTranscript.language || env.TRANSCRIPTION_LANGUAGE || 'und',
            duration: 0, // duration not known from on-device path; diarization gate uses this
            metadata: { provider: 'on-device' },
          };
        } else {
          if (!env.USE_CLIENT_TRANSCRIPT) {
            const skippedClientTranscript = await db.transcript.findUnique({
              where: { recordingId },
              select: { text: true },
            });
            if (skippedClientTranscript?.text?.trim()) {
              log('Ignoring client on-device transcript — using cloud STT for language accuracy');
            }
          }
          // Step 3b: Server-side transcription (cloud fallback).
          const recordingMeta = await db.recording.findUnique({
            where: { id: recordingId },
            select: {
              fileSize: true,
            },
          });
          const shouldChunkTranscription =
            providerName === 'openai' ||
            normalizedMime === 'audio/webm' ||
            normalizedMime === 'audio/ogg' ||
            (recordingMeta?.fileSize ?? 0) >= LONG_RECORDING_FILE_SIZE_BYTES;

          log('Transcribing audio via cloud provider');
          transcriptionResult = shouldChunkTranscription
            ? await transcribeInChunks(downloadUrl, normalizedMime, log, transcriptionOptions)
            : env.ENABLE_FFMPEG_TRANSCODE &&
                (normalizedMime === 'audio/webm' || normalizedMime === 'audio/ogg')
              ? await withTempTranscodeToWav16kMono(
                  { url: downloadUrl, inputMimeType: normalizedMime },
                  async ({ buffer, mimeType: outMime }) =>
                    transcribe(
                      { type: 'buffer', data: buffer, mimeType: outMime },
                      transcriptionOptions
                    )
                )
              : await transcribe({ type: 'url', url: downloadUrl, mimeType }, transcriptionOptions);
        }

        log(
          `Transcription complete: ${transcriptionResult.text.length} chars, ${transcriptionResult.segments?.length ?? 0} segments`
        );
        await job.updateProgress(70);

        // Step 4: Perform speaker diarization
        let diarizationResult: DiarizationResult | null = null;
        let tmpAudioPath: string | null = null;

        try {
          const transcriptionDuration = transcriptionResult.duration ?? 0;
          if (transcriptionDuration > MAX_DIARIZATION_DURATION_SEC) {
            log(`Skipping diarization for long recording (${Math.round(transcriptionDuration)}s)`);
            throw new Error('skip_diarization_for_long_recording');
          }

          log('Starting speaker diarization');

          // Download audio file to temp location for diarization
          tmpAudioPath = path.join(os.tmpdir(), `recording-${recordingId}-${Date.now()}.wav`);
          const response = await fetch(downloadUrl);
          const buffer = await response.buffer();
          fs.writeFileSync(tmpAudioPath, buffer);

          // Convert transcript segments to the format expected by diarization service
          const transcriptSegments = transcriptionResult.segments?.map((seg: WhisperSegment) => ({
            start: seg.start,
            end: seg.end,
            text: seg.text,
          }));

          // Fetch user's voice embedding for personalized diarization
          const user = await db.user.findUnique({
            where: { id: userId },
            select: { voiceEmbedding: true, hasVoiceProfile: true },
          });

          const userEmbedding =
            user?.hasVoiceProfile && user.voiceEmbedding
              ? (user.voiceEmbedding as number[])
              : undefined;

          if (userEmbedding) {
            log(`👤 Using personalized diarization for user ${userId}`);
          }

          // Call diarization service
          diarizationResult = await diarizeAudio(tmpAudioPath, transcriptSegments, userEmbedding);
          log(`Diarization complete: ${diarizationResult.num_speakers} speakers detected`);

          // Merge diarization results with transcript segments (including on-device
          // transcripts that have text but no Whisper timestamp segments).
          if (diarizationResult.segments.length > 0) {
            transcriptionResult.segments = applyDiarizationLabels(
              transcriptionResult,
              diarizationResult.segments
            );
            if (transcriptionResult.segments.some((seg) => seg.speaker)) {
              transcriptionResult.text = formatLabeledTranscriptText(transcriptionResult.segments);
            }
            log(`Merged ${transcriptionResult.segments.length} segments with speaker labels`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          if (message !== 'skip_diarization_for_long_recording') {
            log(`Diarization warning: ${message}`);
          }
          // Continue without diarization if it fails
        } finally {
          // Clean up temp file
          if (tmpAudioPath && fs.existsSync(tmpAudioPath)) {
            fs.unlinkSync(tmpAudioPath);
          }
        }

        await job.updateProgress(75);

        // Step 5: Save transcript to database (upsert so retries overwrite old/mock transcripts)
        log('Saving transcript to database');
        const transcript = await db.transcript.upsert({
          where: { recordingId },
          create: {
            recordingId,
            text: transcriptionResult.text,
            segments: transcriptionResult.segments as unknown as Parameters<
              typeof db.transcript.create
            >[0]['data']['segments'],
            language: transcriptionResult.language,
            numSpeakers: diarizationResult?.num_speakers,
            speakers: diarizationResult?.speakers as unknown as Parameters<
              typeof db.transcript.create
            >[0]['data']['speakers'],
          },
          update: {
            text: transcriptionResult.text,
            segments: transcriptionResult.segments as unknown as Parameters<
              typeof db.transcript.create
            >[0]['data']['segments'],
            language: transcriptionResult.language,
            numSpeakers: diarizationResult?.num_speakers,
            speakers: diarizationResult?.speakers as unknown as Parameters<
              typeof db.transcript.create
            >[0]['data']['speakers'],
          },
        });

        // Update recording duration if available
        if (transcriptionResult.duration) {
          await db.recording.update({
            where: { id: recordingId },
            data: { duration: Math.round(transcriptionResult.duration) },
          });

          // Bill the user's monthly audio-minute budget. The chunk-upload
          // pre-check rejects new chunks once the cap is hit, so this just
          // records what was spent. Round up to be conservative against
          // partial-minute drift.
          await incrementAudioMinutes(userId, transcriptionResult.duration / 60);
        }
        await job.updateProgress(85);

        // Step 6: Mark transcription job as complete
        await updateJobStatus(jobId, 'complete');

        // Step 7: Get recording details
        const recording = await db.recording.findUnique({
          where: { id: recordingId },
        });

        // Session chunks skip the per-chunk debrief — only the session-level
        // debrief (which joins all chunk transcripts) matters. For an N-chunk
        // session this avoids N wasted GPT-4o calls and lets the recording
        // flip to `complete` immediately so the session-debrief trigger fires.
        if (recording && recording.sessionId) {
          log(`Session chunk — skipping per-chunk debrief (sessionId=${recording.sessionId})`);
          await db.recording.update({
            where: { id: recordingId },
            data: { status: 'complete' },
          });
          await maybeEnqueueSessionDebrief(recording.sessionId, userId, log);
        } else if (recording && debriefQueue) {
          log('Enqueueing per-recording debrief job');
          const debriefDbJob = await db.job.create({
            data: {
              recordingId,
              type: 'DEBRIEF',
              status: 'pending',
            },
          });

          const debriefJobData: DebriefJobData = {
            recordingId,
            jobId: debriefDbJob.id,
            transcriptId: transcript.id,
            transcriptText: transcriptionResult.text,
            recordingMode: recording.mode,
            recordingTitle: recording.title,
            userId,
            recordingDuration:
              recording.duration ??
              (transcriptionResult.duration ? Math.round(transcriptionResult.duration) : undefined),
          };

          await debriefQueue.add(`debrief-${recordingId}`, debriefJobData, {
            delay: 1000, // Small delay to ensure DB transaction is committed
          });
        }

        await job.updateProgress(100);
        log('Transcription job complete');

        return {
          transcriptId: transcript.id,
          text: transcriptionResult.text,
          segmentCount: transcriptionResult.segments?.length ?? 0,
          language: transcriptionResult.language,
        };
      } catch (error) {
        log(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);

        // Update job status to failed
        await updateJobStatus(
          jobId,
          'failed',
          error instanceof Error ? error.message : 'Unknown error'
        );

        // Update recording status to failed
        await db.recording.update({
          where: { id: recordingId },
          data: { status: 'failed' },
        });

        throw error;
      }
    },
    getWorkerOptions()
  );

  // Event handlers
  transcriptionWorker.on('completed', (job) => {
    console.log(`[Transcription:${job.id}] Completed successfully`);
  });

  transcriptionWorker.on('failed', (job, error) => {
    console.error(`[Transcription:${job?.id}] Failed:`, error.message);
  });

  transcriptionWorker.on('progress', (job, progress) => {
    console.log(`[Transcription:${job.id}] Progress: ${progress}%`);
  });

  return transcriptionWorker;
}

async function transcribeInChunks(
  downloadUrl: string,
  inputMimeType: string,
  log: (msg: string) => void,
  transcriptionOptions: TranscriptionOptions
): Promise<{
  text: string;
  segments: Array<{
    start: number;
    end: number;
    text: string;
    speaker?: string;
    confidence?: number;
  }>;
  language: string;
  duration: number;
  metadata: { model?: string; chunkCount: number };
}> {
  return withTempSplitUrlToWav16kMonoChunks(
    {
      url: downloadUrl,
      inputMimeType,
      segmentSeconds: TRANSCRIPTION_CHUNK_SECONDS,
    },
    async (chunks) => {
      const mergedText: string[] = [];
      const mergedSegments: Array<{
        start: number;
        end: number;
        text: string;
        speaker?: string;
        confidence?: number;
      }> = [];
      let totalDuration = 0;
      let language = transcriptionOptions.language ?? 'und';
      let modelName: string | undefined;
      let chunkCount = 0;

      for await (const chunk of chunks) {
        chunkCount += 1;
        log(`Transcribing chunk ${chunk.index + 1}`);
        const result = await transcribe(
          { type: 'buffer', data: chunk.buffer, mimeType: chunk.mimeType },
          transcriptionOptions
        );

        if (result.text.trim()) {
          mergedText.push(result.text.trim());
        }

        const offset = totalDuration || chunk.estimatedOffsetSec;
        const adjustedSegments = (result.segments ?? []).map((segment) => ({
          ...segment,
          start: segment.start + offset,
          end: segment.end + offset,
        }));
        mergedSegments.push(...adjustedSegments);

        totalDuration +=
          result.duration ??
          (adjustedSegments.length > 0
            ? adjustedSegments[adjustedSegments.length - 1]!.end - offset
            : TRANSCRIPTION_CHUNK_SECONDS);
        language = result.language || language;
        modelName = typeof result.metadata?.model === 'string' ? result.metadata.model : modelName;
      }

      return {
        text: mergedText.join('\n\n'),
        segments: mergedSegments,
        language,
        duration: totalDuration,
        metadata: {
          model: modelName,
          chunkCount,
        },
      };
    }
  );
}

export async function stopTranscriptionWorker(): Promise<void> {
  if (transcriptionWorker) {
    await transcriptionWorker.close();
    transcriptionWorker = null;
  }
}

// ============================================
// Helper Functions
// ============================================

async function updateJobStatus(
  jobId: string,
  status: 'pending' | 'running' | 'complete' | 'failed',
  error?: string
): Promise<void> {
  const data: {
    status: typeof status;
    error?: string;
    startedAt?: Date;
    completedAt?: Date;
  } = { status };

  if (status === 'running') {
    data.startedAt = new Date();
  }

  if (status === 'complete' || status === 'failed') {
    data.completedAt = new Date();
  }

  if (error) {
    data.error = error;
  }

  await db.job.update({
    where: { id: jobId },
    data,
  });
}

// ============================================
// Queue Helper
// ============================================

/**
 * Add a transcription job to the queue. Throws if Redis is not configured.
 */
export async function enqueueTranscriptionJob(data: TranscriptionJobData): Promise<string> {
  if (!transcriptionQueue) {
    throw new Error(
      'Job queue is not available (Redis not configured). Set REDIS_URL to enable recording processing.'
    );
  }
  const job = await transcriptionQueue.add(`transcribe-${data.recordingId}`, data, {
    jobId: `transcribe-${data.recordingId}-${Date.now()}`,
  });
  return job.id!;
}

/**
 * Retry transcription for an existing recording.
 * Creates a new TRANSCRIBE job record and enqueues it.
 */
export async function retryTranscriptionJob(recordingId: string): Promise<string | null> {
  const recording = await db.recording.findUnique({
    where: { id: recordingId },
  });

  if (!recording?.objectKey) return null;

  // Flip status back to processing while we retry
  await db.recording.update({
    where: { id: recordingId },
    data: { status: 'processing' },
  });

  // Create a new transcription job in DB
  const dbJob = await db.job.create({
    data: {
      recordingId,
      type: 'TRANSCRIBE',
      status: 'pending',
    },
  });

  const jobData: TranscriptionJobData = {
    recordingId,
    jobId: dbJob.id,
    objectKey: recording.objectKey,
    mimeType: recording.mimeType || 'audio/mpeg',
    userId: recording.userId,
  };

  return enqueueTranscriptionJob(jobData);
}
