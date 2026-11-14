<#
.SYNOPSIS
  Regenerates the small, synthetic test videos in test/fixtures.

.DESCRIPTION
  speech.mp4  14 s, 640x360. 0-7 s: title card "OPTIVUS DEMO"; hard scene cut at 7 s to a test pattern
              with the caption "INVOICE 4821". Synthetic speech starts at 1.5 s (exercises the
              "first speech does not start at 0" path) and is produced by the Windows speech synthesizer.
  silent.mp4  5 s, 320x240 test pattern without any audio stream (exercises the "no audio" path).
  rotated.mp4 silent.mp4 with a 90 degree display-matrix rotation, like portrait phone videos.

  Everything is generated locally, so the fixtures carry no third-party media rights.
  Requirements: Windows PowerShell 5.1+ (System.Speech) and ffmpeg on PATH.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'test/fixtures'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$tmp = New-Item -ItemType Directory -Force -Path (Join-Path ([IO.Path]::GetTempPath()) 'optivus-fixtures')
$wav = Join-Path $tmp 'speech.wav'

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.SetOutputToWaveFile($wav)
    $synth.Speak('Hello, thank you for calling Optivus support. My name is Anna. How can I help you today? ' +
                 'I would like to check the status of invoice four eight two one, please.')
}
finally {
    $synth.Dispose()
}

$font = 'C\:/Windows/Fonts/arial.ttf'
$filter = "[0:v]drawtext=fontfile='$font':text='OPTIVUS DEMO':fontsize=48:fontcolor=white:x=(w-tw)/2:y=(h-th)/2[a];" +
          "[1:v]drawtext=fontfile='$font':text='INVOICE 4821':fontsize=44:fontcolor=black:box=1:boxcolor=white:boxborderw=8:x=(w-tw)/2:y=h-90[b];" +
          "[a][b]concat=n=2:v=1:a=0[v];" +
          "[2:a]adelay=delays=1500:all=1,apad,atrim=0:14,aresample=16000[aout]"

ffmpeg -y -hide_banner -loglevel error `
    -f lavfi -i 'color=c=0x1e3a5f:s=640x360:r=25:d=7' `
    -f lavfi -i 'testsrc2=s=640x360:r=25:d=7' `
    -i $wav `
    -filter_complex $filter -map '[v]' -map '[aout]' `
    -c:v libx264 -preset veryslow -crf 30 -pix_fmt yuv420p `
    -c:a aac -b:a 32k -ac 1 -movflags +faststart -t 14 (Join-Path $out 'speech.mp4')
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed for speech.mp4 ($LASTEXITCODE)" }

ffmpeg -y -hide_banner -loglevel error `
    -f lavfi -i 'testsrc2=s=320x240:r=15:d=5' `
    -c:v libx264 -preset veryslow -crf 32 -pix_fmt yuv420p -an -movflags +faststart (Join-Path $out 'silent.mp4')
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed for silent.mp4 ($LASTEXITCODE)" }

ffmpeg -y -hide_banner -loglevel error -display_rotation 90 -i (Join-Path $out 'silent.mp4') -c copy (Join-Path $out 'rotated.mp4')
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed for rotated.mp4 ($LASTEXITCODE)" }

Get-ChildItem $out -Filter *.mp4 | Select-Object Name, Length
