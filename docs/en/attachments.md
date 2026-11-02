# Chat attachments

[User guide](README.md) · [简体中文](../zh-CN/attachments.md)

Attachments supply material for a task. Use [Knowledge](knowledge.md) for references you want to reuse over time.

## Add material

1. Choose the attachment button in a private or group conversation. Supported input areas also accept pasted images or dropped files.
2. Wait for reading or extraction to finish and check the file name.
3. Explain how the Bot should use the material, then send the message.

Supported formats include UTF-8 `.txt`, `.md`, `.csv`, and `.json`, plus `.png`, `.jpg`, `.jpeg`, `.webp`, and `.gif`. An available Linux workspace also enables text extraction from PDF, DOCX, XLSX, and PPTX. The file picker reflects the actual capability.

## Format and size limits

- Original-file uploads have a 5 MiB per-file limit. Text handled directly also has a 200 KiB text limit. Extracted content is bounded separately, so not every 5 MiB document can be fully extracted.
- A task accepts up to four attachments. Retained originals and extracted text currently have per-Bot quotas of 50 MiB and 20 MiB respectively; content retained in trash also counts until cleaned up.
- Images require a vision-capable model. If a selected group recipient lacks image support, change the model or recipients before sending.
- PDF and Office extraction runs in Linux and is not currently available in Windows native mode.
- Scanned PDFs need OCR first; encrypted documents need decryption. Extraction does not fully preserve layouts, images, charts, or formulas and does not recalculate spreadsheets.

## Manage retained attachments

Open the chat attachment manager from the files panel to search, download retained content, move attachments to trash, or restore them. Trashed attachments cannot be task inputs until restored.

Permanent cleanup releases the relevant quota and may make historical references unreadable. Check whether you still need the original or extracted text. Database files may not shrink immediately, so disk-file size alone does not establish whether cleanup succeeded.

Material used by a task can be sent to the selected model provider. Do not upload API keys as ordinary reference files. See [Privacy and permissions](privacy.md).
