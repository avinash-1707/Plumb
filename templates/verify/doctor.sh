#!/bin/sh
# Doctor for the verify-{{plumb:slug}} skill: is this run's instance worth driving?
# Usage: .plumb/bin/doctor <run-id>
# plumb:managed:start doctor
set -eu
if [ "$#" -ne 1 ]; then
  echo "usage: .plumb/bin/doctor <run-id>" >&2
  exit 2
fi
RUN_ID=$1
cd "$(dirname "$0")/../.."
plumb verify --doctor "$RUN_ID"
# URL_<TARGET> for every run target with an HTTP probe, e.g. URL_API=http://localhost:51234
. ".plumb/evidence/$RUN_ID/urls.env"
# plumb:managed:end doctor

# App-specific checks below this line are kept when Plumb regenerates the block above.
{{fill: App-specific read-only checks as POSIX sh using the URL_<TARGET> variables, each printing a one-line reason and exiting 1 on failure, or a single comment saying there are none.}}
