# Front door for a 3D-print project (see the 3d-print-modeling skill's "Project layout").
# All Python lives in src/; outputs route into stl/<subsystem>/ and web/. Run `make help`.
PORT ?= 8765

.PHONY: help install build export viewer shot fits watch metrics-list metrics-compare all

help:                ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  make %-14s %s\n", $$1, $$2}'

install:             ## Install the build toolchain + headless browser
	python3 -m pip install -r requirements.txt
	python3 -m playwright install chromium

build:               ## Rebuild every STL + web/assembly.glb (source of truth: src/build.py)
	python3 src/build.py
# Tip: content-hash cache lives in .cache/build/ (BUILD_CACHE=0 to force; BUILD_CACHE_CLEAR=1 to wipe).
# Fitmap often owns ~99% of wall time on mature assemblies — watch uses SKIP_FITS=1.

export:              ## Write sliceable Bambu .3mf plates into exports/
	python3 src/export_bambu.py

viewer:              ## Serve the live viewer (auto-reloads on rebuild; override with PORT=)
	python3 src/serve.py $(PORT)

shot:                ## Headless multi-angle render to .claude/renders/ (needs `make viewer` running)
	python3 src/shoot.py assembly.glb chk $(PORT)

fits:                ## Canonical fitmap / contact audit (slow; not for the watch loop)
	python3 src/fitmap.py web/assembly.glb

watch:               ## Rebuild on src change with SKIP_FITS=1 (viewer stays snappy)
	SKIP_FITS=1 python3 src/watch.py

metrics-list:        ## List archived build timings (metrics/index.jsonl)
	python3 src/metrics.py list

metrics-compare:     ## Compare two runs: make metrics-compare A=prev B=latest
	python3 src/metrics.py compare $(or $(A),prev) $(or $(B),latest)

all: build export    ## Rebuild all parts + Bambu plates

# Add one target per extra subsystem script, e.g.:
# keypad:            ## Rebuild the rotary keypad parts
# 	python3 src/build_rotary_keypad.py
