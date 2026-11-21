#!/bin/zsh
open "chrome://extensions"
open "https://koddo.to/"
osascript -e 'display dialog "1. Enable Developer mode in Chrome Extensions\n2. Choose Load unpacked\n3. Select the telebee project folder\n4. Open the Telebee side panel\n5. Enter the WSS server URL supplied by the server setup" buttons {"OK"} default button "OK"'
