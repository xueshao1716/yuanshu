' 2026-10-08 无窗口启动 node watchdog，避免托盘区出现黑色控制台窗口
' wscript.exe /B "run-hidden.vbs" — /B 本身也无对话框
Dim sh : Set sh = CreateObject("WScript.Shell")
Dim root : root = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
root = Left(root, InStrRev(root, "\") - 1)
Dim node : node = root & "\runtime\node\node.exe"
Dim svc  : svc  = root & "\launcher\service.cjs"
sh.Run """" & node & """ """ & svc & """", 0, False
