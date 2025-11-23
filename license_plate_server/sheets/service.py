"""
Google Sheets service using a service account.
"""
from typing import List, Optional, Any, Dict
import os

from google.oauth2 import service_account
from googleapiclient.discovery import build, Resource

from server.config import SERVICE_ACCOUNT_FILE, SPREADSHEET_ID, SCOPES

class SheetsService:
    """Service class for interacting with Google Sheets API."""
    
    def __init__(self):
        """Initialize the Sheets service with service account credentials."""
        self.spreadsheet_id = SPREADSHEET_ID
        self.credentials = None
        self.service = None
        self._authenticate()
    
    def _authenticate(self) -> None:
        """Authenticate with Google Sheets API using service account."""
        try:
            if not os.path.exists(SERVICE_ACCOUNT_FILE):
                raise FileNotFoundError(f"Service account file not found: {SERVICE_ACCOUNT_FILE}")
            
            self.credentials = service_account.Credentials.from_service_account_file(
                SERVICE_ACCOUNT_FILE, scopes=SCOPES
            )
            
            self.service = build('sheets', 'v4', credentials=self.credentials)
            print("Successfully authenticated with Google Sheets API")
        except Exception as e:
            print(f"Error authenticating with Google Sheets API: {e}")
            raise
    
    def _get_sheets_service(self) -> Resource:
        """Get the authenticated sheets service."""
        if not self.service:
            self._authenticate()
        return self.service
    
    def get_values(self, sheet_name: str, range_name: Optional[str] = None) -> List[List[Any]]:
        """Get values from a sheet."""
        sheets = self._get_sheets_service()
        
        if range_name:
            range_to_get = f"{sheet_name}!{range_name}"
        else:
            range_to_get = sheet_name
            
        result = sheets.spreadsheets().values().get(
            spreadsheetId=self.spreadsheet_id,
            range=range_to_get
        ).execute()
        
        return result.get('values', [])
    
    def append_values(self, sheet_name: str, values: List[List[Any]]) -> Dict[str, Any]:
        """Append values to a sheet."""
        sheets = self._get_sheets_service()
        
        body = {
            'values': values
        }
        
        result = sheets.spreadsheets().values().append(
            spreadsheetId=self.spreadsheet_id,
            range=sheet_name,
            valueInputOption='RAW',
            insertDataOption='INSERT_ROWS',
            body=body
        ).execute()
        
        return result
    
    def update_values(self, range_name: str, values: List[List[Any]]) -> Dict[str, Any]:
        """Update values in a specific range."""
        sheets = self._get_sheets_service()
        
        body = {
            'values': values
        }
        
        result = sheets.spreadsheets().values().update(
            spreadsheetId=self.spreadsheet_id,
            range=range_name,
            valueInputOption='RAW',
            body=body
        ).execute()
        
        return result
    
    def get_sheet_id(self, sheet_name: str) -> Optional[int]:
        """Get the numeric ID of a sheet by name."""
        sheets = self._get_sheets_service()
        
        sheet_metadata = sheets.spreadsheets().get(
            spreadsheetId=self.spreadsheet_id
        ).execute()
        
        for sheet in sheet_metadata.get('sheets', []):
            if sheet.get('properties', {}).get('title') == sheet_name:
                return sheet.get('properties', {}).get('sheetId')
        
        return None
    
    def delete_row(self, sheet_name: str, row_index: int) -> Dict[str, Any]:
        """Delete a row from a sheet by index (0-based)."""
        sheets = self._get_sheets_service()
        
        sheet_id = self.get_sheet_id(sheet_name)
        if not sheet_id:
            raise ValueError(f"Sheet not found: {sheet_name}")
        
        batch_update_request = {
            'requests': [
                {
                    'deleteDimension': {
                        'range': {
                            'sheetId': sheet_id,
                            'dimension': 'ROWS',
                            'startIndex': row_index,
                            'endIndex': row_index + 1
                        }
                    }
                }
            ]
        }
        
        result = sheets.spreadsheets().batchUpdate(
            spreadsheetId=self.spreadsheet_id,
            body=batch_update_request
        ).execute()
        
        return result


# Create a singleton instance
sheets_service = SheetsService() 