# Liga (ou desliga, com -Desligar) o Concord junto com o Windows: um atalho na pasta Inicializar, que roda o
# Concord escondido quando você entra no Windows. Não precisa de administrador.
param([switch]$Desligar)
. (Join-Path $PSScriptRoot 'comum.ps1')
if (-not $NoWindows) { Aviso 'Isso só existe no Windows.'; exit 0 }

$atalho = Join-Path ([Environment]::GetFolderPath('Startup')) 'Concord (servidor).lnk'
if ($Desligar) {
  Remove-Item -LiteralPath $atalho -ErrorAction SilentlyContinue
  Ok 'O Concord não liga mais junto com o Windows.'
  exit 0
}
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($atalho)
$lnk.TargetPath = $PsExe
$lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Pasta 'servico.ps1') + '"'
$lnk.WorkingDirectory = $Pasta
$lnk.WindowStyle = 7   # minimizado (a janela some em seguida)
$lnk.Description = 'Liga o servidor do Concord'
$lnk.Save()
Ok 'O Concord vai ligar sozinho quando você entrar no Windows.'
