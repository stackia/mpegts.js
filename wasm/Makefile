# Top-level Makefile for WASM audio decoders

.PHONY: all clean minimp3 liba52

all: minimp3 liba52

minimp3:
	$(MAKE) -C minimp3

liba52:
	$(MAKE) -C liba52

clean:
	$(MAKE) -C minimp3 clean
	$(MAKE) -C liba52 clean
