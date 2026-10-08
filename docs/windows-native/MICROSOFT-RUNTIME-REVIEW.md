# Microsoft compiler and runtime provenance

Reviewed on this physical Windows machine on 2026-10-08. This is artifact-level
build evidence, not a claim that the complete Windows distribution is ready.

The installed Visual Studio instance is Community 18.5.11716.220 on
`VisualStudio.18.Release`. Its MSVC compiler is Microsoft-signed. The SDK already
installed is 10.0.19041.0. Missing headers and import libraries were obtained from
the official Visual Studio catalog as the exact three packages recorded in
`scripts/windows/msvc-supplement.lock.json`; SHA-256 verification is mandatory.
No preview compiler, third-party compiler mirror, elevated build-tool installer,
or compiler component is required by the distributed application.

The [Community license](https://visualstudio.microsoft.com/license-terms/vs2026-ga-community/)
allows individual development and organizational development of applications
released under OSI-approved open-source licenses. Its distributable-code section
permits object-code redistribution of the REDIST list with substantial application
functionality, subject to its distribution requirements. The exact official DOCX
is preserved under `artifacts/windows-native/sources` for the release evidence.

The [Visual Studio 2026 redistribution list](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution)
includes release files beneath VC/redist, excludes debug_nonredist and preview
components, and requires unmodified copies distributed with the application.
`Copy-MsvcRuntime.ps1` includes only these release files, checks their exact hash
and valid Microsoft Authenticode signature, and copies them beside the private
application runtimes:

| File | SHA-256 |
| --- | --- |
| vcruntime140.dll | 184146852727a9db4eea06178716bec3cdbb1015c911f6b0f915b184ad7775b2 |
| vcruntime140_1.dll | e6bfb3662ab4b1969a73441dbe35c96d51441b6bff8cf1fe7430bd5b246ca605 |
| msvcp140.dll | def46aa6a8f72f27bafac0c43334419486a4d1dcdb6c479a8ef7034b3e1fa4cb |
| vcomp140.dll | 31af29c03643f8396a6f26bcd601c6369d26493d7d78b714827ab2801bd284c7 |

These are separately licensed Microsoft files. Josi's AGPL does not purport to
relicense them. The installer must present and retain appropriate third-party
terms; distributors and external end users must agree to terms protecting the
Microsoft code as required by the Community license. The license also assigns
distribution-related indemnification obligations to the distributor, except for
claims based solely on Microsoft code. Preserve attribution, do not imply
Microsoft endorsement, and never include debug/compiler/header/import-library
packages in runtime assets.

The license review establishes a conditional redistribution path; it is not
authorization to publish. Release remains gated on completed notices and recipient
terms, the remaining component license/source review, signed physical acceptance,
and Roman's explicit publication approval. The current payload is local staging.
