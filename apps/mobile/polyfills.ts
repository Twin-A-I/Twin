// Ensure React Native's network polyfills (FormData, fetch, File, Blob, etc.)
// are initialised before expo/src/winter/runtime.native.ts runs.
//
// expo/Expo.fx.tsx → winter/index.ts → runtime.native.ts calls
// `installFormDataPatch(FormData)` at the top-level of that module.
// In React Native 0.81 the lazy-global setup may not have executed yet by the
// time Metro evaluates the first `import 'expo'` line, causing:
// ReferenceError: Property 'FormData' doesn't exist.
//
// Do not import `Libraries/Core/setUpXHR`: it is a React Native private module
// and is excluded from the production package used by EAS. Import the network
// implementation directly and register only the global Expo needs.
// @ts-expect-error React Native does not publish a TypeScript declaration here.
import ReactNativeFormData from 'react-native/Libraries/Network/FormData';

const globals = globalThis as typeof globalThis & { FormData?: unknown };
if (globals.FormData === undefined) {
  globals.FormData = ReactNativeFormData;
}
