// Stands in for a Node-only module JSZip asks for. `readable-stream` is only
// probed (`support.nodestream`) and `setimmediate` is a global polyfill that
// `set-immediate.mjs` replaces.
module.exports = {};
