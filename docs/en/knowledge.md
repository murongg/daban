# Documents and knowledge revisions

[User guide](README.md) · [简体中文](../zh-CN/knowledge.md)

Open **Documents** in a Bot's workspace for persistent knowledge references. Documents belong to that Bot. Groups currently have no independent shared knowledge library; select a member to inspect its documents.

## Create, import, and find

1. Create a document with a name and body, or import a file.
2. Use UTF-8 Markdown, TXT, CSV, or JSON. An available Linux workspace also extracts text from PDF, DOCX, XLSX, and PPTX.
3. Inspect the imported content before asking the Bot to rely on it.
4. Search by keyword and open documents for the full text.

A document body is limited to 200 KiB; original uploads are limited to 5 MiB. Scans need OCR first and encrypted files need decryption. Windows native mode currently cannot parse PDF or Office documents.

## Originals and extracted snapshots

Imports are text snapshots. Later changes to the source file do not synchronize automatically; import again or explicitly update the saved body.

PDF/Office originals are retained separately from extracted text. Editing the text does not change the original. Images, layout, charts, and formulas are not fully reproduced. Download the saved text or retained original separately and remember that their contents may differ.

## Edit, trash, and restore

Open, edit, and save a document. Review current backend content before resolving revision conflicts.

Use revision history to inspect retained versions. Restoring an older version creates a new current version instead of erasing intervening edits. Trashing retains history; a retained non-deleted version can restore the document.

## Ask a Bot to use knowledge

Example: “Read the project specification in your knowledge library and cite relevant passages, rather than inferring from its title.” Bots can search and read documents; the entire library is not necessarily inserted into every task's context.

Automatic source synchronization, general OCR, and comprehensive vector retrieval are not guaranteed features. Document content is reference material, not new authority, and may be sent to the selected model when read. See [Bot transfer](bot-transfer.md) to share selected documents.
