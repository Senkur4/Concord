# Liga o Concord (escondido, sem janela) e espera ele responder.
param([switch]$Silencioso)
. (Join-Path $PSScriptRoot 'comum.ps1')

if (Supervisor-Ativo) {
  if (-not $Silencioso) { Escrever 'O Concord já está ligado.' 'Green' }
} else {
  if (-not (Test-Path -LiteralPath (Join-Path $Raiz 'client\dist\index.html'))) { throw 'O Concord ainda não foi instalado: rode o instalar.bat primeiro.' }
  if (Porta-Ocupada 3000) {
    throw 'A porta 3000 já está em uso (o Concord ainda está no Docker?). Pare o Docker com: docker compose -f docker-compose.dev.yml down'
  }
  $argumentos = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $Pasta 'servico.ps1') + '"'))
  if ($NoWindows) {
    Start-Process -FilePath $PsExe -ArgumentList (@('-WindowStyle', 'Hidden') + $argumentos) -WindowStyle Hidden
  } else {
    Start-Process -FilePath $PsExe -ArgumentList $argumentos -RedirectStandardOutput (Join-Path $Run 'servico.saida') -RedirectStandardError (Join-Path $Run 'servico.erros')
  }
  if (-not $Silencioso) { Escrever 'Ligando o Concord...' }
}

$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  if (Concord-Respondendo) { $ok = $true; break }
  Start-Sleep -Milliseconds 500
}
$ip = (Ler-Env)['HOST_IP']
if ($ok) {
  if (-not $Silencioso) {
    Escrever ''
    Escrever "Concord no ar: http://${ip}:3000" 'Green'
    Escrever "  neste PC também: http://localhost:3000"
    Escrever "  registros (se algo der errado): $Logs"
  }
} else {
  Aviso 'O Concord não respondeu em 30 segundos.'
  Escrever "Veja os registros em $Logs (concord.erros.log e servico.log)."
  exit 1
}
