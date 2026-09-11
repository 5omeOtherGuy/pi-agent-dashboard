/**
 * Package entry point. Pi loads every `.ts` file under `extensions/`, so this file
 * only re-exports the extension implementation from `src/`.
 */
export { default } from "../src/extension/index.ts";
