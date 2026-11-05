// JSZip's lib/flate.js asks pako for `Deflate` and `Inflate`. Mapdown writes
// .xmind entries uncompressed (STORE) and only inflates when it reads archives
// that XMind compressed, so only pako's inflate half is bundled. Relative path:
// the `pako` alias would otherwise catch this import too.
module.exports = { Inflate: require("../../node_modules/pako/lib/inflate.js").Inflate };
