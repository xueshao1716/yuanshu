' Start the Yuanshu watchdog without a console window (invoked by the scheduled task).
' ASCII only on purpose: wscript reads .vbs as ANSI, so non-ASCII comments can corrupt parsing.
'
' 2026-10-22: This file was referenced by register-task.ps1 / build but never shipped,
' so on some machines the task ended up launching node.exe directly -- which Windows 11
' hosts inside Windows Terminal, leaving a permanent "node.exe" console window on screen.
Dim sh : Set sh = CreateObject("WScript.Shell")
Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
Dim root : root = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
root = Left(root, InStrRev(root, "\") - 1)
Dim node : node = root & "\runtime\node\node.exe"
If Not fso.FileExists(node) Then node = "node"
Dim svc : svc = root & "\launcher\service.cjs"
sh.CurrentDirectory = root
sh.Run """" & node & """ """ & svc & """", 0, False
