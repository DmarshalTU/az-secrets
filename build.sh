#!/bin/bash

# Azure Secrets Explorer Build Script
# This script helps build the application for different platforms

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to setup icons
setup_icons() {
    print_status "Setting up icons for build..."
    
    # Check if icon.png exists
    if [ ! -f "assets/icon.png" ]; then
        print_error "assets/icon.png not found! Please add an icon file."
        exit 1
    fi
    
    # Create macOS icon if needed
    if [ ! -f "assets/icon.icns" ]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            print_status "Creating macOS icon..."
            mkdir -p assets/icon.iconset
            sips -z 16 16 assets/icon.png --out assets/icon.iconset/icon_16x16.png
            sips -z 32 32 assets/icon.png --out assets/icon.iconset/icon_16x16@2x.png
            sips -z 32 32 assets/icon.png --out assets/icon.iconset/icon_32x32.png
            sips -z 64 64 assets/icon.png --out assets/icon.iconset/icon_32x32@2x.png
            sips -z 128 128 assets/icon.png --out assets/icon.iconset/icon_128x128.png
            sips -z 256 256 assets/icon.png --out assets/icon.iconset/icon_128x128@2x.png
            sips -z 256 256 assets/icon.png --out assets/icon.iconset/icon_256x256.png
            sips -z 512 512 assets/icon.png --out assets/icon.iconset/icon_256x256@2x.png
            sips -z 512 512 assets/icon.png --out assets/icon.iconset/icon_512x512.png
            sips -z 1024 1024 assets/icon.png --out assets/icon.iconset/icon_512x512@2x.png
            iconutil -c icns assets/icon.iconset -o assets/icon.icns
            print_success "macOS icon created"
        else
            print_warning "macOS icon not created (not on macOS). You'll need to create assets/icon.icns manually."
        fi
    fi
    
    # Create Windows icon if needed
    if [ ! -f "assets/icon.ico" ]; then
        if command_exists convert; then
            print_status "Creating Windows icon..."
            convert assets/icon.png -define icon:auto-resize=256,128,64,48,32,16 assets/icon.ico
            print_success "Windows icon created"
        else
            print_warning "Windows icon not created (ImageMagick not found). You'll need to create assets/icon.ico manually."
        fi
    fi
}

# Function to install dependencies
install_dependencies() {
    print_status "Installing dependencies..."
    
    if [ ! -d "node_modules" ]; then
        npm install
    else
        npm ci
    fi
    
    print_success "Dependencies installed"
}

# Function to build for current platform
build_current() {
    print_status "Building for current platform..."
    npm run build
    print_success "Build completed"
}

# Function to build for specific platform
build_platform() {
    local platform=$1
    print_status "Building for $platform..."
    
    case $platform in
        "windows"|"win")
            npm run build:win
            ;;
        "macos"|"mac")
            npm run build:mac
            ;;
        "linux")
            npm run build:linux
            ;;
        "all")
            npm run build:all
            ;;
        *)
            print_error "Unknown platform: $platform"
            print_status "Available platforms: windows, macos, linux, all"
            exit 1
            ;;
    esac
    
    print_success "Build completed for $platform"
}

# Function to clean build
clean_build() {
    print_status "Cleaning build artifacts..."
    rm -rf dist/
    print_success "Build artifacts cleaned"
}

# Function to show help
show_help() {
    echo "Azure Secrets Explorer Build Script"
    echo ""
    echo "Usage: $0 [OPTIONS] [PLATFORM]"
    echo ""
    echo "Options:"
    echo "  -h, --help     Show this help message"
    echo "  -c, --clean    Clean build artifacts before building"
    echo "  -i, --icons    Setup icons only"
    echo "  -d, --deps     Install dependencies only"
    echo ""
    echo "Platforms:"
    echo "  windows, win   Build for Windows"
    echo "  macos, mac     Build for macOS"
    echo "  linux          Build for Linux"
    echo "  all            Build for all platforms"
    echo "  (none)         Build for current platform"
    echo ""
    echo "Examples:"
    echo "  $0                    # Build for current platform"
    echo "  $0 windows            # Build for Windows"
    echo "  $0 --clean all        # Clean and build for all platforms"
    echo "  $0 --icons            # Setup icons only"
}

# Main script
main() {
    local clean=false
    local icons_only=false
    local deps_only=false
    local platform=""
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                show_help
                exit 0
                ;;
            -c|--clean)
                clean=true
                shift
                ;;
            -i|--icons)
                icons_only=true
                shift
                ;;
            -d|--deps)
                deps_only=true
                shift
                ;;
            -*)
                print_error "Unknown option: $1"
                show_help
                exit 1
                ;;
            *)
                platform="$1"
                shift
                ;;
        esac
    done
    
    # Check if we're in the right directory
    if [ ! -f "package.json" ]; then
        print_error "package.json not found. Please run this script from the project root."
        exit 1
    fi
    
    # Setup icons
    setup_icons
    
    if [ "$icons_only" = true ]; then
        print_success "Icons setup completed"
        exit 0
    fi
    
    # Install dependencies
    install_dependencies
    
    if [ "$deps_only" = true ]; then
        print_success "Dependencies installation completed"
        exit 0
    fi
    
    # Clean if requested
    if [ "$clean" = true ]; then
        clean_build
    fi
    
    # Build
    if [ -z "$platform" ]; then
        build_current
    else
        build_platform "$platform"
    fi
    
    print_success "Build process completed successfully!"
    print_status "Check the 'dist' directory for build outputs."
}

# Run main function with all arguments
main "$@" 