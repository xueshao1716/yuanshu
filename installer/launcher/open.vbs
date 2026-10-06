' 元枢启动器：无黑窗运行 open.cjs；服务起不来时弹窗说明。
Option Explicit
Dim sh, fso, here, node, code, args
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
node = fso.BuildPath(fso.GetParentFolderName(here), "runtime\node\node.exe")
args = ""
If WScript.Arguments.Count > 0 Then args = " " & WScript.Arguments(0)
code = sh.Run("""" & node & """ """ & fso.BuildPath(here, "open.cjs") & """" & args, 0, True)
If code <> 0 And args = "" Then
  MsgBox "元枢服务没有启动成功。" & vbCrLf & vbCrLf & _
    "可以先等半分钟再点一次；仍不行请查看日志：" & vbCrLf & _
    fso.BuildPath(fso.GetParentFolderName(here), "app\watchdog.log"), vbExclamation, "元枢"
End If
