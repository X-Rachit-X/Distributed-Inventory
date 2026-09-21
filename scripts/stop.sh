#!/usr/bin/env bash
# Stop every Tessera service process.
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
  powershell.exe -NoProfile -Command "
    Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |
      Where-Object { \$_.CommandLine -match 'services[\\/][a-z-]+[\\/]src[\\/]index\.js' } |
      ForEach-Object { Stop-Process -Id \$_.ProcessId -Force; 'stopped pid ' + \$_.ProcessId }
  " 2>/dev/null | tr -d '\r'
else
  pkill -f 'services/[a-z-]*/src/index.js' && echo "stopped" || echo "nothing running"
fi
