# WASM Audio Decoders

This directory contains third-party C audio decoder libraries compiled to WebAssembly for browser-side audio decoding.

## Libraries

### minimp3

- **Source**: https://github.com/lieff/minimp3
- **Version**: Latest as of 2026-01
- **License**: CC0 (Public Domain)
- **Purpose**: MPEG Audio Layer 1/2/3 decoding
- **Files**: `minimp3/minimp3.h` (header-only library)

### liba52

- **Source**: http://liba52.sourceforge.net/
- **Version**: 0.7.4
- **License**: GPL-2.0
- **Purpose**: AC-3 (Dolby Digital) audio decoding
- **Files**: Core decoding files in `liba52/`

## Building

Requires [Emscripten](https://emscripten.org/) to be installed and activated.

```bash
# Build all decoders
make

# Build individual decoders
make -C minimp3
make -C liba52

# Clean build artifacts
make clean
```

## Output

After building, the following files are generated:

- `minimp3/mp2_decoder.js` - ES6 module loader
- `minimp3/mp2_decoder.wasm` - WebAssembly binary
- `liba52/ac3_decoder.js` - ES6 module loader
- `liba52/ac3_decoder.wasm` - WebAssembly binary

## Modifications

Any modifications to the original source code are documented in this section:

### minimp3
- No modifications to the original header file

### liba52
- Removed command-line tool code
- Removed djbfft dependency (using built-in IMDCT)
