# Makefile for liba52 WASM decoder

EMCC = emcc
OUTPUT = ac3_decoder

# Source files
LIBA52_SRC = src/bit_allocate.c src/bitstream.c src/downmix.c src/imdct.c src/parse.c
WRAPPER_SRC = ac3_decoder.c

# Include paths
INCLUDES = -I. -Iinclude -Isrc

# Emscripten flags
EMFLAGS = -O3 \
	-flto \
	-s WASM=1 \
	-s MODULARIZE=1 \
	-s EXPORT_ES6=1 \
	-s EXPORTED_FUNCTIONS='["_ac3_decoder_create", "_ac3_decoder_destroy", "_ac3_syncinfo", "_ac3_decode_frame", "_ac3_samples_per_frame", "_ac3_max_channels", "_malloc", "_free"]' \
	-s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "getValue", "setValue", "HEAPU8", "HEAP16", "HEAPF32", "HEAP32"]' \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=2097152 \
	-s STACK_SIZE=65536 \
	-s NO_EXIT_RUNTIME=1 \
	-s FILESYSTEM=0 \
	-s ENVIRONMENT='web,worker' \
	--no-entry

.PHONY: all clean

all: $(OUTPUT).js

$(OUTPUT).js: $(WRAPPER_SRC) $(LIBA52_SRC)
	$(EMCC) $(EMFLAGS) $(INCLUDES) $(WRAPPER_SRC) $(LIBA52_SRC) -o $(OUTPUT).js

clean:
	rm -f $(OUTPUT).js $(OUTPUT).wasm
