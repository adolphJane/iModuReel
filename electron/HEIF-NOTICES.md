# HEIF decoder components

Photo import uses the unmodified `libheif-js` 1.23.5 WebAssembly package, distributed under LGPL-3.0. The package includes the license texts for its compiled library. It is loaded at runtime from `node_modules/libheif-js`, which the installer keeps separate from the application archive in `app.asar.unpacked/node_modules/libheif-js`. A compatible build can replace that directory while the application is closed.

- [Exact libheif-js source and npm build scripts](https://github.com/catdad-experiments/libheif-js/tree/d8ec4bc3bc5bf8055975577bccbbc7e1d7313c2d)
- [Upstream WebAssembly build scripts and binaries](https://github.com/catdad-experiments/libheif-emscripten/releases/tag/v1.23.5)
- [Libheif source](https://github.com/strukturag/libheif/tree/v1.23.5)
- [PNG.js 7.0.0 source and MIT license](https://github.com/pngjs/pngjs/tree/v7.0.0)
