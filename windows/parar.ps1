# Desliga o Concord (o LiveKit, o servidor e os bots).
. (Join-Path $PSScriptRoot 'comum.ps1')

$sup = Supervisor-Ativo
if (-not $sup) {
  Escrever 'O Concord não estava ligado.'
} else {
  New-Item -ItemType Directory -Force -Path $Run | Out-Null
  Set-Content -LiteralPath $ArquivoParar -Value 'parar'
  Escrever 'Desligando o Concord...'
  for ($i = 0; $i -lt 30 -and (Supervisor-Ativo); $i++) { Start-Sleep -Milliseconds 500 }
  if (Supervisor-Ativo) {
    # não saiu sozinho: desliga à força (ele e o que ele ligou)
    if (Test-Path -LiteralPath $ArquivoPids) {
      foreach ($id in (Get-Content -LiteralPath $ArquivoPids)) { if ($id) { Matar-Arvore ([int]$id) } }
    }
    Matar-Arvore $sup.Id
    Remove-Item -LiteralPath $ArquivoPids, $ArquivoPidSupervisor, $ArquivoParar -ErrorAction SilentlyContinue
  }
  Escrever 'Concord desligado.' 'Green'
}
