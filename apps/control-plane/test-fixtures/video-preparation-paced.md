# Paced Preparation Fixture

`video-preparation-paced.webm` is synthetic: 12 seconds of a blue 1280×720 background
at 30 fps, with one red rectangle on source frame 157. It has no application or Session data,
audio, or external assets. The fixture exercises native readable dimensions, 360 complete
presentation frames, one-frame defect retention, and contiguous bounded segment coverage.

Generated with the installed FFmpeg, without a network request:

```sh
ffmpeg -nostdin -hide_banner -loglevel error \
  -f lavfi -i 'color=c=blue:s=1280x720:r=30:d=12' \
  -vf 'drawbox=x=320:y=180:w=640:h=360:color=red:t=fill:enable=eq(n\,157)' \
  -an -c:v libvpx-vp9 -lossless 1 -threads 1 \
  apps/control-plane/test-fixtures/video-preparation-paced.webm
```

This documented oracle is for deterministic infrastructure tests. It is not a blind live-model
challenge; live validation must generate a fresh sanitized challenge and withhold its oracle
from the reviewing model.
