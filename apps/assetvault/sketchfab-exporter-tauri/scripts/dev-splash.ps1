param([string]$StateFile,[string]$ImagePath)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form=New-Object System.Windows.Forms.Form
$form.Text='Arvimo'
$form.Size=New-Object System.Drawing.Size(520,340)
$form.StartPosition='CenterScreen'
$form.FormBorderStyle='FixedDialog'
$form.MaximizeBox=$false
$form.MinimizeBox=$false
$form.BackColor=[System.Drawing.Color]::FromArgb(13,17,23)
$form.ForeColor=[System.Drawing.Color]::FromArgb(200,243,83)
$picture=New-Object System.Windows.Forms.PictureBox
$picture.Bounds=New-Object System.Drawing.Rectangle(207,24,90,90)
$picture.SizeMode='Zoom'
if(Test-Path -LiteralPath $ImagePath){$picture.Image=[System.Drawing.Image]::FromFile($ImagePath)}
$form.Controls.Add($picture)
$title=New-Object System.Windows.Forms.Label
$title.Text='Arvimo'
$title.Font=New-Object System.Drawing.Font('Segoe UI',22,[System.Drawing.FontStyle]::Bold)
$title.TextAlign='MiddleCenter'
$title.Bounds=New-Object System.Drawing.Rectangle(20,125,480,48)
$form.Controls.Add($title)
$label=New-Object System.Windows.Forms.Label
$label.Text='Starting development workspace...'
$label.TextAlign='MiddleCenter'
$label.Bounds=New-Object System.Drawing.Rectangle(20,183,480,40)
$form.Controls.Add($label)
$bar=New-Object System.Windows.Forms.ProgressBar
$bar.Bounds=New-Object System.Drawing.Rectangle(70,244,370,10)
$bar.Style='Marquee'
$form.Controls.Add($bar)
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=150
$timer.Add_Tick({
 try{
  $state=Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
  if($state.done){$form.Close();return}
  if($state.message){$label.Text=$state.message}
 }catch{}
})
$timer.Start()
try{[System.Windows.Forms.Application]::Run($form)}finally{
 $timer.Stop();$timer.Dispose()
 if($picture.Image){$picture.Image.Dispose()}
 $form.Dispose()
}
