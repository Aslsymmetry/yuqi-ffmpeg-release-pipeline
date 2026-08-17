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
install_name_tool -id '@loader_path/lib/libmp3lame.0.dylib' "$LAME_PREFIX/lib/libmp3lame.0.dylib"

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
install -m 0755 ffmpeg "$OUTPUT/ffmpeg"
install -m 0755 ffprobe "$OUTPUT/ffprobe"
install -m 0755 "$LAME_PREFIX/lib/libmp3lame.0.dylib" "$OUTPUT/lib/libmp3lame.0.dylib"
for binary in "$OUTPUT/ffmpeg" "$OUTPUT/ffprobe"; do
  old=$(otool -L "$binary" | awk '/libmp3lame\.0\.dylib/{print $1; exit}')
  [ -n "$old" ] || { echo "Missing LAME dependency: $binary" >&2; exit 1; }
  [ "$old" = '@loader_path/lib/libmp3lame.0.dylib' ] || install_name_tool -change "$old" '@loader_path/lib/libmp3lame.0.dylib' "$binary"
done
for binary in "$OUTPUT/lib/libmp3lame.0.dylib" "$OUTPUT/ffprobe" "$OUTPUT/ffmpeg"; do
  codesign --force --sign - --timestamp=none "$binary"
  codesign --verify --strict "$binary"
done
if strings "$OUTPUT/ffmpeg" "$OUTPUT/ffprobe" "$OUTPUT/lib/libmp3lame.0.dylib" | grep -E '/tmp/yuqi-ffmpeg-release-build|/private/tmp/|/var/folders/|/Users/|/opt/homebrew|/usr/local' >/dev/null; then
  echo 'Forbidden build-machine path embedded in output' >&2; exit 1
fi
echo "Built verified candidate set in $OUTPUT"
