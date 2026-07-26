-- Which kind of row the Google Sheets trigger fires on: "data" (skip merged
-- heading rows), "headings" (only when a heading's text changes), or "all".
--
-- Defaults to 'all' — the behaviour before the trigger understood headings — so
-- every existing poll keeps firing exactly as it does today, and keeps making a
-- single API call per poll ('data'/'headings' need a second request for the
-- tab's merged ranges). New nodes are offered 'data' by the dialog instead.
ALTER TABLE "GoogleSheetsPoll" ADD COLUMN     "rowScope" TEXT NOT NULL DEFAULT 'all';
