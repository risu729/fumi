# Attachment retrieval representations

Status: bounded MIME decoding and private attachment storage are active. Managed
document/OCR adapters, durable derivative coverage, lexical citations, local ZIP
decryption and isolated PDF decryption are implemented with synthetic Workers
tests as of 2026-11-12; see [conversion and activation](attachment-conversion.md).
Their provider bindings, private opt-in and real-document acceptance remain
separate activation steps. Visual/semantic retrieval is not established by these
text projections.

## Text is useful, not a universal prerequisite

RAG needs a searchable representation, not necessarily a separately generated
plain-text file. Representations can include text/Markdown, structured tables,
OCR, image/page embeddings and metadata. Keep immutable original bytes in R2;
search derivatives do not replace them. A managed service can create its own
representation from a supported original attachment.

Fumi now uses managed extraction/OCR and text for lexical search,
retaining original attachment/page access for visual evidence. Add visual
retrieval when queries need diagrams, layout or information extraction misses.
Text provides exact identifier/amount matching and inspectable snippets; it is
not a complete representation of every chart or scan.

## What runs where

| Input                                                  | Initial treatment                                                                                                                                 | Evidence retained                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Email MIME                                             | Parse bounded MIME into body and attachment parts                                                                                                 | Original MIME, envelope and part identity                               |
| Supported PDF/DOCX/spreadsheet                         | Offer the supported attachment to AI Search for managed conversion, or explicitly use Workers AI `toMarkdown` when fumi needs a stored derivative | Original, conversion version/status and available page/sheet references |
| Scanned PDF/image with printed text                    | Enable OCR for text search; retain the visual source                                                                                              | OCR as derived text plus original scan                                  |
| Diagram/photo/chart                                    | Optional multimodal image retrieval and vision at answer time                                                                                     | Original image and any labeled caption/derived representation           |
| Password-protected file or ZIP                         | Unlock/extract bounded derivatives before indexing                                                                                                | Encrypted original and separate verified derivatives                    |
| Unlisted format, audio/video, oversized or failed file | Report coverage state; add a format-specific adapter only when needed                                                                             | Original plus explicit unsupported/pending/error status                 |

AI Search documents automatic conversion for formats including PDF, DOCX and
Excel-family files; a custom `.txt` object is not required first. OCR is an explicit
setting, disabled by default. Its reviewed format list does not promise PPTX, legacy
DOC, audio or video support.
[Supported sources and OCR](https://developers.cloudflare.com/ai-search/configuration/data-source/),
[conversion formats](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/).

`env.AI.toMarkdown()` is also available to a fumi normalizer. Standard image
conversion generates a description; that is not the same as a verbatim OCR
transcript. Preserve that distinction in provenance and UI.
[Binding API](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/),
[conversion behavior](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/).

An R2 archive success does not imply index success. AI Search reports locked
files explicitly, and its indexing-size limits are lower than the email transport
limit for some formats. Expose incomplete coverage rather than hiding failures.
[Indexing errors](https://developers.cloudflare.com/ai-search/troubleshooting/indexing-error-codes/),
[indexing limits](https://developers.cloudflare.com/ai-search/platform/limits-pricing/).

## Multimodal retrieval and answer generation are different

AI Search offers image-capable embedding choices, including a Cloudflare-hosted
multimodal model. Choosing a vision-capable answer model alone does not make a text-only
retrieval index visual. Configure and evaluate the embedding path separately.
[Model roles](https://developers.cloudflare.com/ai-search/configuration/models/),
[supported models](https://developers.cloudflare.com/ai-search/configuration/models/supported-models/).

Direct PDF embeddings also exist: Google's Gemini embedding documentation accepts
PDF input. This establishes that self-managed text extraction is not a universal
RAG requirement, but does not prove Cloudflare forwards PDFs to that exact model
path. Cloudflare's documented PDF flow includes conversion/OCR. No external
embedding provider is selected for fumi by this comparison.
[Google embedding inputs](https://ai.google.dev/gemini-api/docs/embeddings).

Retrieving a page/image vector is different from giving an already selected page
to a vision model to answer a question. fumi can add either separately. Audio
would similarly need a dedicated adapter, for example speech recognition into a
time-coded transcript; it is not automatically supported by Markdown conversion.

## Provenance and evaluation

Record source message/attachment IDs, original/derivative hashes, representation
type, extraction/model/configuration version and coverage status. Preserve page,
sheet/cell or time references when the extractor actually supplies them. Do not
invent bounding boxes or page-level citations when a managed result only identifies
a file/chunk. OCR and generated captions are derived interpretations.

Keep useful tables as rows/cells and headings/page boundaries where possible.
Test Japanese scans, exact IDs/amounts, multi-sheet tables, chart-only questions,
encrypted/unsupported/oversized files and attachment-only evidence. Compare
retrieval recall and verifiable citations, not just plausible answers.

DecisionRAG still needs useful hierarchy/node descriptions and evidence. Raw
attachment storage alone does not build that representation, so it is not a way
to skip corpus preparation. [DecisionRAG paper](https://arxiv.org/html/2610.35868).
