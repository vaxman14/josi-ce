# Documentation help chat

The authenticated Josi CE shell always shows **Help** and a link to the public
documentation. Its optional chat answers from retrieved public documentation
excerpts only. It has no access to workspace content, conversations, connected
accounts, tools, or installation secrets.

To enable chat, save a Groq API key at `secrets/groq_api_key`, set its mode to
`0600`, and recreate the `web` service. Docker mounts the secrets directory
read-only. The API reads the key from that file at startup; it never returns or
logs it. If the file is absent, unreadable, or empty, the interface says chat is
unavailable and keeps the ordinary documentation link usable.

Each signed-in user may ask eight questions per minute. Questions are limited
to 800 characters, retrieved documentation is capped, and Groq output is capped
at 500 tokens. Questions are not stored by this feature. Provider and
documentation failures produce an explicit unavailable state rather than an
ungrounded answer.
