Option Explicit
Dim shell, files, root, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
command = Chr(34) & shell.ExpandEnvironmentStrings("%SystemRoot%\System32\cmd.exe") & Chr(34) & " /c " & Chr(34) & Chr(34) & root & "\Start-Arvimo-Dev.cmd" & Chr(34) & " --console" & Chr(34)
shell.Run command, 0, False
