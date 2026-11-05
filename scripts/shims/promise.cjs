// JSZip falls back to the `lie` Promise polyfill only when there is no native
// Promise; every Obsidian platform has one.
module.exports = Promise;
