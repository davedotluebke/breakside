#!/usr/bin/env python3

import json
import sys
import os
from datetime import datetime

VERSION_FILE = 'version.json'

def increment_version():
    """Increment build number"""
    try:
        # Read current version
        with open(VERSION_FILE, 'r') as f:
            version_data = json.load(f)
        
        # Increment build number
        version_data['build'] = str(int(version_data['build']) + 1)
        
        # Update timestamp
        version_data['lastUpdated'] = datetime.now().isoformat() + 'Z'
        
        # Write back to file
        with open(VERSION_FILE, 'w') as f:
            json.dump(version_data, f, indent=2)
            f.write('\n')
        
        print(f"Version updated: {version_data['version']} (Build {version_data['build']})")
        return version_data
    except Exception as error:
        print(f'Error incrementing version: {error}')
        sys.exit(1)

def increment_patch_version():
    """Increment patch version"""
    try:
        # Read current version
        with open(VERSION_FILE, 'r') as f:
            version_data = json.load(f)
        
        # Parse version string (e.g., "1.0.0")
        version_parts = [int(x) for x in version_data['version'].split('.')]
        
        # Increment patch version
        version_parts[2] += 1
        
        # Update version string
        version_data['version'] = '.'.join(map(str, version_parts))
        
        # Increment build number
        version_data['build'] = str(int(version_data['build']) + 1)
        
        # Update timestamp
        version_data['lastUpdated'] = datetime.now().isoformat() + 'Z'
        
        # Write back to file
        with open(VERSION_FILE, 'w') as f:
            json.dump(version_data, f, indent=2)
            f.write('\n')
        
        print(f"Version updated: {version_data['version']} (Build {version_data['build']})")
        return version_data
    except Exception as error:
        print(f'Error incrementing version: {error}')
        sys.exit(1)

def increment_minor_version():
    """Increment minor version and reset patch"""
    try:
        # Read current version
        with open(VERSION_FILE, 'r') as f:
            version_data = json.load(f)
        
        # Parse version string (e.g., "1.0.0")
        version_parts = [int(x) for x in version_data['version'].split('.')]
        
        # Increment minor version and reset patch
        version_parts[1] += 1
        version_parts[2] = 0
        
        # Update version string
        version_data['version'] = '.'.join(map(str, version_parts))
        
        # Reset build number
        version_data['build'] = '1'
        
        # Update timestamp
        version_data['lastUpdated'] = datetime.now().isoformat() + 'Z'
        
        # Write back to file
        with open(VERSION_FILE, 'w') as f:
            json.dump(version_data, f, indent=2)
            f.write('\n')
        
        print(f"Version updated: {version_data['version']} (Build {version_data['build']})")
        return version_data
    except Exception as error:
        print(f'Error incrementing version: {error}')
        sys.exit(1)

def increment_major_version():
    """Increment major version and reset minor and patch"""
    try:
        # Read current version
        with open(VERSION_FILE, 'r') as f:
            version_data = json.load(f)
        
        # Parse version string (e.g., "1.0.0")
        version_parts = [int(x) for x in version_data['version'].split('.')]
        
        # Increment major version and reset minor and patch
        version_parts[0] += 1
        version_parts[1] = 0
        version_parts[2] = 0
        
        # Update version string
        version_data['version'] = '.'.join(map(str, version_parts))
        
        # Reset build number
        version_data['build'] = '1'
        
        # Update timestamp
        version_data['lastUpdated'] = datetime.now().isoformat() + 'Z'
        
        # Write back to file
        with open(VERSION_FILE, 'w') as f:
            json.dump(version_data, f, indent=2)
            f.write('\n')
        
        print(f"Version updated: {version_data['version']} (Build {version_data['build']})")
        return version_data
    except Exception as error:
        print(f'Error incrementing version: {error}')
        sys.exit(1)

# Command line interface
if len(sys.argv) > 1:
    command = sys.argv[1]
else:
    command = 'build'

if command == 'major':
    increment_major_version()
elif command == 'minor':
    increment_minor_version()
elif command == 'patch':
    increment_patch_version()
elif command == 'build':
    increment_version()
else:
    print('Usage: python3 increment-version.py [major|minor|patch|build]')
    print('  major  - Increment major version (1.0.0 -> 2.0.0)')
    print('  minor  - Increment minor version (1.0.0 -> 1.1.0)')
    print('  patch  - Increment patch version (1.1.1 -> 1.1.2)')
    print('  build  - Increment build number (default)')
    sys.exit(1)

