#!/bin/bash

# Build Icons Script for Azure Secrets Explorer
# This script helps generate the necessary icon files for all platforms

echo "🔧 Setting up build icons for Azure Secrets Explorer..."

# Check if icon.png exists
if [ ! -f "assets/icon.png" ]; then
    echo "❌ Error: assets/icon.png not found!"
    echo "Please ensure you have an icon.png file in the assets directory."
    exit 1
fi

# Create build directory if it doesn't exist
mkdir -p build

echo "📱 Generating platform-specific icons..."

# For macOS, we need .icns file
# You'll need to install iconutil and create an .iconset directory
echo "🍎 For macOS (.icns):"
echo "   You'll need to create an .iconset directory with the following sizes:"
echo "   - icon_16x16.png (16x16)"
echo "   - icon_16x16@2x.png (32x32)"
echo "   - icon_32x32.png (32x32)"
echo "   - icon_32x32@2x.png (64x64)"
echo "   - icon_128x128.png (128x128)"
echo "   - icon_128x128@2x.png (256x256)"
echo "   - icon_256x256.png (256x256)"
echo "   - icon_256x256@2x.png (512x512)"
echo "   - icon_512x512.png (512x512)"
echo "   - icon_512x512@2x.png (1024x1024)"
echo ""
echo "   Then run: iconutil -c icns assets/icon.iconset -o assets/icon.icns"

# For Windows, we need .ico file
echo "🪟 For Windows (.ico):"
echo "   You'll need to create an .ico file with multiple sizes."
echo "   You can use online converters or tools like ImageMagick:"
echo "   convert assets/icon.png -define icon:auto-resize=256,128,64,48,32,16 assets/icon.ico"

# For Linux, .png is already available
echo "🐧 For Linux (.png):"
echo "   ✅ assets/icon.png is already available"

echo ""
echo "📋 Manual steps required:"
echo "1. Create assets/icon.icns for macOS"
echo "2. Create assets/icon.ico for Windows"
echo "3. Ensure assets/icon.png is at least 512x512 pixels for best results"
echo ""
echo "💡 Tip: You can use online tools like:"
echo "   - https://cloudconvert.com/png-to-icns (for macOS)"
echo "   - https://cloudconvert.com/png-to-ico (for Windows)"
echo "   - Or use ImageMagick if installed: brew install imagemagick (macOS)"
echo ""
echo "🚀 Once icons are ready, you can build with:"
echo "   npm run build:all" 