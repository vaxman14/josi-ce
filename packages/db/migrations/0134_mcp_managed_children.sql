-- Custom MCP: whether an account a parent manages may add MCP servers.
--
-- The owner's setting, off by default. An MCP server gives Josi tools the
-- parent never saw and topics the parent's rules do not cover, so a managed
-- child account does not get them unless the owner says so. It is one switch
-- for the installation: the owner cannot see which accounts are managed, and
-- this does not tell them.
alter table mcp_policy
  add column if not exists allow_managed_children boolean not null default false;
