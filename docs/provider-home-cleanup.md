# Provider HOME Cleanup Status

Provider-account removal forgets the configured account and reports `credentialsRetained: true`.
Failed, cancelled, duplicate and spawn-failed sign-ins also retain their credential HOME, scratch
files and canonical lease evidence. Completed sign-ins keep their configured account as before.
Profile grant settlement, process reaping, local reservations, skill serialization and configuration
write protections remain in effect.

Physical HOME cleanup is disabled because the current implementation cannot prove durable management
provenance, exclude paused old cleanup and dormant consumers, or serialize deletion with successor
admission. A matching path/profile, successful lease release or absent credential file is insufficient.
No new namespace, sentinel, external fence, terminal CAS or native detach mechanism is implemented.

The [retirement proposal](provider-home-retirement-protocol.md) records source findings and the
proof obligations for a future implementation. Its candidate mechanisms are not supported features.
In particular, safe physical removal of configured accounts still needs the complete consumer-binding
retirement contract described there. This change is a partial safety slice of #3157 and does not close
the issue. It does not make an already running old binary safe or prove a reproduced data-loss incident.
