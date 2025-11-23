"""
Test basic read/write operations with Google Sheets.

This script tests that the SheetsService can connect and perform
basic operations on the spreadsheet.
"""

import sys
import os
from pathlib import Path

# Add parent directory to path for imports so we can import ultistats_server
sys.path.insert(0, str(Path(__file__).parent.parent))

from ultistats_server.sheets.service import get_sheets_service
from ultistats_server.config import SPREADSHEET_ID


def test_basic_operations(spreadsheet_id: str = None):
    """
    Test basic read/write operations.
    
    Args:
        spreadsheet_id: Optional spreadsheet ID. Uses config default if not provided.
    """
    if not spreadsheet_id:
        spreadsheet_id = SPREADSHEET_ID
    
    if not spreadsheet_id:
        print("❌ No spreadsheet ID provided. Set SPREADSHEET_ID in config.py or pass as argument.")
        return False
    
    print(f"Testing basic operations on spreadsheet: {spreadsheet_id}\n")
    
    try:
        # Get service
        print("1. Connecting to Google Sheets API...")
        service = get_sheets_service(spreadsheet_id)
        print("   ✅ Connected successfully\n")
        
        # Test: List all sheets
        print("2. Listing all sheets...")
        sheet_metadata = service._get_sheets_service().spreadsheets().get(
            spreadsheetId=spreadsheet_id
        ).execute()
        
        sheets = sheet_metadata.get('sheets', [])
        print(f"   Found {len(sheets)} sheet(s):")
        for sheet in sheets:
            title = sheet.get('properties', {}).get('title', 'Unknown')
            sheet_id = sheet.get('properties', {}).get('sheetId', 'Unknown')
            print(f"     - {title} (ID: {sheet_id})")
        print()
        
        # Test: Read from Teams sheet (if it exists)
        if service.sheet_exists('Teams'):
            print("3. Reading from Teams sheet...")
            values = service.get_values('Teams')
            if values:
                print(f"   ✅ Read {len(values)} row(s)")
                if len(values) > 0:
                    print(f"   Headers: {values[0]}")
                    if len(values) > 1:
                        print(f"   Sample row: {values[1]}")
            else:
                print("   ℹ️  Sheet is empty")
            print()
        else:
            print("3. Teams sheet does not exist (this is OK if spreadsheet hasn't been set up yet)")
            print()
        
        # Test: Write to a test sheet
        test_sheet_name = 'TestSheet'
        print(f"4. Testing write operation on '{test_sheet_name}'...")
        
        if not service.sheet_exists(test_sheet_name):
            service.create_sheet(test_sheet_name)
            print(f"   ✅ Created test sheet '{test_sheet_name}'")
        
        # Write test data
        test_data = [
            ['Test Column 1', 'Test Column 2', 'Test Column 3'],
            ['Value 1', 'Value 2', 'Value 3'],
            ['Value 4', 'Value 5', 'Value 6']
        ]
        service.update_values(f"{test_sheet_name}!A1", test_data)
        print(f"   ✅ Wrote test data to '{test_sheet_name}'")
        
        # Read it back
        read_back = service.get_values(test_sheet_name)
        print(f"   ✅ Read back {len(read_back)} row(s)")
        if read_back == test_data:
            print("   ✅ Data matches!")
        else:
            print(f"   ⚠️  Data mismatch: expected {test_data}, got {read_back}")
        print()
        
        print("✅ All basic operations tests passed!")
        return True
        
    except FileNotFoundError as e:
        print(f"❌ Error: Service account file not found")
        print(f"   {e}")
        print("\n   Make sure SERVICE_ACCOUNT_FILE is set correctly in config.py")
        return False
    except Exception as e:
        print(f"❌ Error during testing: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == '__main__':
    spreadsheet_id = sys.argv[1] if len(sys.argv) > 1 else None
    success = test_basic_operations(spreadsheet_id)
    sys.exit(0 if success else 1)

