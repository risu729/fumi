# Optional processing activation

The normal deployment workflow reads these optional repository/environment
variables. Empty values omit the corresponding binding:

| Variable | Binding |
| --- | --- |
| `FUMI_PDF_PARSER_ENABLED=1` | `PDF_LOADER`, local isolated decryption |
| `FUMI_DOCUMENT_CONVERSION_ENABLED=1` | `AI`, managed document conversion |
| `FUMI_ATTACHMENT_OCR_INSTANCE` | `ATTACHMENT_OCR`, a pre-existing private default-namespace AI Search instance |
| `FUMI_MANAGED_SEARCH_INSTANCE` | `MANAGED_MAIL_SEARCH`, a distinct private default-namespace AI Search instance |

These bindings alone do not enable processing. Private configuration and finite call
budgets are separately required; see [attachment conversion](attachment-conversion.md)
and [managed search](managed-mail-search.md). Configure the OCR instance with OCR
enabled. Keep corpus and OCR public endpoints disabled. Query rewriting, generated
answers, reranking and cache reuse are disabled by the retrieval adapter.

Apply migrations 0010 through 0013 before deploying the integrated runtime. Their
tables contain private dispatch state, attachment derivatives, classification
context and managed corpus evidence. Preserve raw MIME and existing migration
records. Verify the actual deployed bindings and private settings after rollout;
neither a successful build nor an instance name proves the provider is ready.

The initial retention policy remains keep-all. No automatic deletion, Gmail
mutation or forwarding retirement is introduced. Originals, decrypted derivatives,
managed OCR items and corpus items need a coordinated, explicitly selected deletion
policy before enabling deletion. Search always fences current local provenance;
that visibility fence is not proof of remote item deletion or storage reclamation.
