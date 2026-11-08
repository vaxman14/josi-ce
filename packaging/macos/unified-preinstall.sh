#!/bin/sh
# Read-only upgrade preflight. Installer owns payload replacement; the existing
# lifecycle owns backups, migrations, service activation and rollback.
set -eu
app='/Applications/Josi.app'
candidate='@VERSION@'
candidate_build='@BUILD@'
if [ -L "$app" ]; then
    echo 'The installed Josi application is a symbolic link. No files were replaced.' >&2
    exit 1
fi
if [ ! -e "$app" ]; then exit 0; fi
/usr/bin/codesign --verify --deep --strict -R '=anchor apple generic and identifier "com.heyjosi.ce.unified" and certificate leaf[subject.OU] = "LRH75YR6QW" and certificate leaf[subject.CN] = "Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)"' "$app"
current=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
current_build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist")
if ! /usr/bin/awk -v current="$current" -v candidate="$candidate" -v old_build="$current_build" -v new_build="$candidate_build" '
function compare(a,b, x,y,n,m,i) {
    if(a !~ /^[0-9]+(\.[0-9]+)*$/ || b !~ /^[0-9]+(\.[0-9]+)*$/) return 2;
    n=split(a,x,"."); m=split(b,y,".");
    for(i=1;i<=n || i<=m;i++) { if(x[i]+0>y[i]+0) return 1; if(x[i]+0<y[i]+0) return -1; }
    return 0;
}
BEGIN { v=compare(current,candidate); if(v==2 || v>0) exit 1; if(v==0 && compare(old_build,new_build)>0) exit 1; exit 0; }'; then
    echo 'A newer Josi version is already installed, or its version cannot be verified. Use a current installer; no files were replaced.' >&2
    exit 1
fi
echo 'Josi upgrade verified. Existing server data and permissions will be retained.'
