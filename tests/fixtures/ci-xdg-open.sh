#!/bin/sh
printf '%s\n' "$@" >> "${DAWITH_TEST_OPEN_LOG:?DAWITH_TEST_OPEN_LOG is required}"
