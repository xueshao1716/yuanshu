' Run the companion nudge probe without a console window (invoked by the scheduled task).
' ASCII only on purpose: wscript reads .vbs as ANSI, so non-ASCII comments can corrupt parsing.
Dim sh : Set sh = CreateObject("WScript.Shell")
Dim root : root = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
root = Left(root, InStrRev(root, "\") - 1)
Dim node : node = root & "\runtime\node\node.exe"
Dim job  : job  = root & "\launcher\nudge.cjs"
sh.Run """" & node & """ """ & job & """", 0, False
