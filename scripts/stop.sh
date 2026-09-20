#!/usr/bin/env bash
powershell.exe -NoProfile -Command "
Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |
  Where-Object { \$_.CommandLine -like '*services/*/src/index.js*' } |
  ForEach-Object { Stop-Process -Id \$_.ProcessId -Force; 'stopped pid ' + \$_.ProcessId }
" 2>/dev/null | tr -d '\r'
