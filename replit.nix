{pkgs}: {
  deps = [
    pkgs.chromium
    pkgs.at-spi2-core
    pkgs.at-spi2-atk
    pkgs.xorg.libxshmfence
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libX11
    pkgs.pango
    pkgs.gtk3
    pkgs.dbus
    pkgs.mesa
    pkgs.libxkbcommon
    pkgs.libdrm
    pkgs.cups
    pkgs.atk
    pkgs.nspr
    pkgs.nss
    pkgs.glib
  ];
}
