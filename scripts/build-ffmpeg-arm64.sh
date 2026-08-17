#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_ROOT=${YUQI_FFMPEG_BUILD_ROOT:-/tmp/yuqi-ffmpeg-release-build}
JOBS=${YUQI_FFMPEG_JOBS:-$(sysctl -n hw.logicalcpu)}
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1786924800}
export SOURCE_DATE_EPOCH ZERO_AR_DATE=1 MACOSX_DEPLOYMENT_TARGET=12.0
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo 'macOS arm64 is required' >&2; exit 1; }

DOWNLOADS="$ROOT/build/downloads"
WORK="$BUILD_ROOT/work"
LAME_PREFIX="$BUILD_ROOT/prefix-lame"
OUTPUT="$ROOT/build/output"
OUTPUT=${YUQI_FFMPEG_OUTPUT:-$OUTPUT}
TRACE=${YUQI_FFMPEG_TRACE_DIR:-}
rm -rf "$WORK" "$LAME_PREFIX" "$OUTPUT"
mkdir -p "$WORK" "$LAME_PREFIX" "$OUTPUT/lib"
tar -xJf "$DOWNLOADS/ffmpeg-9.0.1.tar.xz" -C "$WORK"
tar -xzf "$DOWNLOADS/lame-3.100.tar.gz" -C "$WORK"
cd "$WORK"
patch -p0 < "$ROOT/patches/lame-3.100-darwin-export.patch"

export CC=/usr/bin/clang CXX=/usr/bin/clang++ AR=/usr/bin/ar RANLIB=/usr/bin/ranlib STRIP=/usr/bin/strip
export CFLAGS='-O2 -arch arm64 -mmacosx-version-min=12.0'
export CXXFLAGS="$CFLAGS"
export LDFLAGS='-arch arm64 -mmacosx-version-min=12.0'
cd "$WORK/lame-3.100"
./configure --prefix="$LAME_PREFIX" --host=arm-apple-darwin --enable-shared --disable-static --disable-frontend --disable-debug --disable-dependency-tracking
make -j"$JOBS"
make install
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$LAME_PREFIX/lib/libmp3lame.0.dylib" libmp3lame link "$TRACE"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$LAME_PREFIX/lib/libmp3lame.0.dylib" libmp3lame strip "$TRACE"
install_name_tool -id '@loader_path/lib/libmp3lame.0.dylib' "$LAME_PREFIX/lib/libmp3lame.0.dylib"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$LAME_PREFIX/lib/libmp3lame.0.dylib" libmp3lame postprocess "$TRACE"

cd "$WORK/ffmpeg-9.0.1"
cat > "$BUILD_ROOT/pkg-config-lame.sh" <<'EOF'
#!/bin/sh
case "$*" in
  *--exists*) exit 0 ;;
  *--modversion*) echo 3.100 ;;
  *--libs*) echo '-lmp3lame' ;;
  *--cflags*) echo '-I../../prefix-lame/include' ;;
  *) exit 0 ;;
esac
EOF
chmod 755 "$BUILD_ROOT/pkg-config-lame.sh"
./configure \
  --prefix=/yuqi-build/ffmpeg \
  --arch=arm64 --cc=/usr/bin/clang --cxx=/usr/bin/clang++ --ar=/usr/bin/ar --ranlib=/usr/bin/ranlib --strip=/usr/bin/strip \
  --enable-ffmpeg --enable-ffprobe --disable-ffplay --disable-doc --disable-debug \
  --disable-network --disable-autodetect --pkg-config=../../pkg-config-lame.sh \
  --enable-libmp3lame --enable-static --disable-shared --disable-gpl --disable-nonfree \
  --extra-cflags='-I../../prefix-lame/include -arch arm64 -mmacosx-version-min=12.0' \
  --extra-ldflags='-L../../prefix-lame/lib -arch arm64 -mmacosx-version-min=12.0'
make -j"$JOBS" ffmpeg ffprobe
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" ffmpeg_g ffmpeg link "$TRACE"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" ffprobe_g ffprobe link "$TRACE"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" ffmpeg ffmpeg strip "$TRACE"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" ffprobe ffprobe strip "$TRACE"
install -m 0755 ffmpeg "$OUTPUT/ffmpeg"
install -m 0755 ffprobe "$OUTPUT/ffprobe"
install -m 0755 "$LAME_PREFIX/lib/libmp3lame.0.dylib" "$OUTPUT/lib/libmp3lame.0.dylib"
for binary in "$OUTPUT/ffmpeg" "$OUTPUT/ffprobe"; do
  old=$(otool -L "$binary" | awk '/libmp3lame\.0\.dylib/{print $1; exit}')
  [ -n "$old" ] || { echo "Missing LAME dependency: $binary" >&2; exit 1; }
  [ "$old" = '@loader_path/lib/libmp3lame.0.dylib' ] || install_name_tool -change "$old" '@loader_path/lib/libmp3lame.0.dylib' "$binary"
done
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$OUTPUT/ffmpeg" ffmpeg postprocess "$TRACE"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$OUTPUT/ffprobe" ffprobe postprocess "$TRACE"
for binary in "$OUTPUT/lib/libmp3lame.0.dylib" "$OUTPUT/ffprobe" "$OUTPUT/ffmpeg"; do
  codesign --remove-signature "$binary"
  node "$ROOT/scripts/normalize-macho-uuid.mjs" "$binary"
done
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$OUTPUT/lib/libmp3lame.0.dylib" libmp3lame pre-codesign "$TRACE"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$OUTPUT/ffmpeg" ffmpeg pre-codesign "$TRACE"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$OUTPUT/ffprobe" ffprobe pre-codesign "$TRACE"
for binary in "$OUTPUT/lib/libmp3lame.0.dylib" "$OUTPUT/ffprobe" "$OUTPUT/ffmpeg"; do
  codesign --force --sign - --timestamp=none "$binary"
  codesign --verify --strict "$binary"
done
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$OUTPUT/lib/libmp3lame.0.dylib" libmp3lame post-codesign "$TRACE"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$OUTPUT/ffmpeg" ffmpeg post-codesign "$TRACE"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$OUTPUT/ffprobe" ffprobe post-codesign "$TRACE"
chmod 0755 "$OUTPUT/ffmpeg" "$OUTPUT/ffprobe"
chmod 0644 "$OUTPUT/lib/libmp3lame.0.dylib"
touch -t "$(date -u -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S)" "$OUTPUT/ffmpeg" "$OUTPUT/ffprobe" "$OUTPUT/lib/libmp3lame.0.dylib"
xattr -c "$OUTPUT/ffmpeg" "$OUTPUT/ffprobe" "$OUTPUT/lib/libmp3lame.0.dylib"
[ "$(find "$OUTPUT" -type l -o -name '._*' -o -name '.DS_Store' | wc -l | tr -d ' ')" = 0 ] || { echo 'Forbidden link or hidden metadata in output' >&2; exit 1; }
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$OUTPUT/lib/libmp3lame.0.dylib" libmp3lame final "$TRACE"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$OUTPUT/ffmpeg" ffmpeg final "$TRACE"
[ -z "$TRACE" ] || node "$ROOT/scripts/capture-binary-stage.mjs" "$OUTPUT/ffprobe" ffprobe final "$TRACE"
if strings "$OUTPUT/ffmpeg" "$OUTPUT/ffprobe" "$OUTPUT/lib/libmp3lame.0.dylib" | grep -E '/tmp/yuqi-ffmpeg-release-build|/private/tmp/|/var/folders/|/Users/|/opt/homebrew|/usr/local' >/dev/null; then
  echo 'Forbidden build-machine path embedded in output' >&2; exit 1
fi
echo "Built verified candidate set in $OUTPUT"
