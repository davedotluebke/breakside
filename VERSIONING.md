# Version Management

This project includes an automatic versioning system that displays the current version at the top of the game log and automatically increments with each commit.

## How It Works

- **Version Display**: The app version appears at the very top of the game log in the format: `App Version: 1.0.0 (Build 3)`
- **Automatic Incrementing**: The build number automatically increments with each git commit
- **Manual Version Control**: You can manually increment major or minor versions when needed

## Files

- `version.json` - Contains the current version information
- `increment-version.py` - Python script to increment versions
- `version.sh` - Shell wrapper script for easy version management
- `.git/hooks/pre-commit` - Git hook that auto-increments build on commit
- `.git/hooks/post-commit` - Git hook that creates release tags

## Usage

### Automatic Versioning (Default)
The build number automatically increments with each commit. No action needed!

### Manual Version Management

```bash
# Increment build number (default)
./version.sh build
# or
python3 increment-version.py build
# or simply
python3 increment-version.py

# Increment minor version (1.0.0 -> 1.1.0)
./version.sh minor
# or
python3 increment-version.py minor

# Increment major version (1.0.0 -> 2.0.0)
./version.sh major
# or
python3 increment-version.py major
```

### Release Tagging
To create a release tag, include "release" or "Release" in your commit message:

```bash
git commit -m "Add new feature - release"
```

This will automatically create a git tag like `v1.0.0`.

## Version Format

- **Version**: Semantic versioning (major.minor.patch) - e.g., "1.0.0"
- **Build**: Incremental build number - e.g., "3"
- **Last Updated**: ISO timestamp of last version change

## Checking Current Version

The version is displayed in two places:
1. At the top of the game log in the app (when the event log is visible)
2. In the `version.json` file

To see the current version from command line:
```bash
python3 -c "import json; print(json.load(open('version.json'))['version'], 'Build', json.load(open('version.json'))['build'])"
```

## Troubleshooting

- If the version doesn't appear in the app, check that `version.json` exists and is accessible
- If automatic incrementing isn't working, ensure the git hooks are executable: `chmod +x .git/hooks/pre-commit`
- Make sure Python 3 is available on your system as the versioning system requires it
- Version information is loaded asynchronously when the app starts, so it may take a moment to appear

