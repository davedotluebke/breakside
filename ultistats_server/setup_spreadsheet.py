"""
Script to set up the master Google Sheets spreadsheet for Ultistats.

This script creates the initial spreadsheet structure with:
- Teams sheet
- Players sheet  
- Games sheet
- Users sheet (for authentication)

Run this once to initialize the spreadsheet structure.
"""

import sys
from pathlib import Path

# Add parent directory to path for imports so we can import ultistats_server
sys.path.insert(0, str(Path(__file__).parent.parent))

from ultistats_server.sheets.service import get_sheets_service


def create_master_spreadsheet(spreadsheet_id: str):
    """
    Create the master spreadsheet structure.
    
    Args:
        spreadsheet_id: The Google Sheets spreadsheet ID
    """
    print(f"Setting up spreadsheet: {spreadsheet_id}\n")
    
    service = get_sheets_service(spreadsheet_id)
    
    # Define sheets to create
    sheets_to_create = [
        {
            'name': 'Teams',
            'headers': ['team_id', 'team_name', 'created_at', 'last_updated']
        },
        {
            'name': 'Players',
            'headers': ['player_id', 'team_id', 'name', 'nickname', 'gender', 'number', 'created_at']
        },
        {
            'name': 'Games',
            'headers': [
                'game_id', 'team_id', 'team_name', 'opponent_name', 'starting_position',
                'game_start_timestamp', 'game_end_timestamp', 'alternate_gender_ratio',
                'alternate_gender_pulls', 'starting_gender_ratio', 'final_score_team',
                'final_score_opponent', 'sheet_name'
            ]
        },
        {
            'name': 'Users',
            'headers': ['username', 'email', 'full_name', 'hashed_password', 'created_at', 'active_games']
        }
    ]
    
    # Create sheets and add headers
    for sheet_info in sheets_to_create:
        sheet_name = sheet_info['name']
        headers = sheet_info['headers']
        
        print(f"Creating sheet: {sheet_name}...")
        
        # Check if sheet already exists
        if service.sheet_exists(sheet_name):
            print(f"  ⚠️  Sheet '{sheet_name}' already exists, skipping creation")
        else:
            # Create the sheet
            service.create_sheet(sheet_name)
            print(f"  ✅ Created sheet '{sheet_name}'")
        
        # Add headers if sheet is empty
        existing_values = service.get_values(sheet_name)
        if not existing_values or len(existing_values) == 0:
            service.update_values(f"{sheet_name}!A1", [headers])
            print(f"  ✅ Added headers to '{sheet_name}'")
        else:
            print(f"  ℹ️  Sheet '{sheet_name}' already has data, skipping headers")
        
        print()
    
    print("✅ Spreadsheet setup complete!")
    print(f"\nSpreadsheet ID: {spreadsheet_id}")
    print("Sheets created:")
    for sheet_info in sheets_to_create:
        print(f"  - {sheet_info['name']}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 setup_spreadsheet.py <SPREADSHEET_ID>")
        print("\nExample:")
        print("  python3 setup_spreadsheet.py 1I_mlDRKCEr2djnrm-URaSgIk4yZ_D2NwygMr8TaJ9kw")
        print("\nNote: Make sure SERVICE_ACCOUNT_FILE and SPREADSHEET_ID are set in config.py or environment variables")
        sys.exit(1)
    
    spreadsheet_id = sys.argv[1]
    create_master_spreadsheet(spreadsheet_id)

