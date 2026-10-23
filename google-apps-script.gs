/**
 * Optional: store BrightSmile voice-agent requests in a Google Sheet.
 *
 * Setup (about 3 minutes):
 * 1. Create a new Google Sheet. Rename the first tab to "Requests".
 * 2. Extensions → Apps Script. Delete the sample code and paste this file.
 * 3. Deploy → New deployment → type "Web app".
 *    Execute as: Me.  Who has access: Anyone.  Click Deploy and authorise.
 * 4. Copy the Web app URL (ends with /exec).
 * 5. In the voice agent, open Settings → Google Sheets, paste the URL, Save, then "Send a test row".
 */
const COLUMNS = ['id', 'type', 'status', 'name', 'phone', 'service', 'preferred_date', 'preferred_time', 'doctor', 'issue', 'priority', 'created_at', 'engine'];

function doPost(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Requests') || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sheet.getLastRow() === 0) sheet.appendRow(COLUMNS);
  const rec = JSON.parse(e.postData.contents);
  // Store the phone as text so Sheets keeps it exactly as given.
  sheet.appendRow(COLUMNS.map(c => (c === 'phone' && rec[c] ? "'" + rec[c] : rec[c] || '')));
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}
