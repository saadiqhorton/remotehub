# wasapi 0.16.0 (RemoteHub patched copy)

This is the upstream `wasapi` crate, version 0.16.0, by Henrik Enquist, licensed
under MIT (see `LICENSE.txt`). Source is from
<https://github.com/HEnquist/wasapi-rs/tree/v0.16.0>.

RemoteHub carries a small patch because upstream 0.16.0 dereferences the packet
pointer before checking `AUDCLNT_BUFFERFLAGS_SILENT`. WASAPI allows that pointer
to be null for silent packets. Both safe capture helpers now zero-fill silent
frames before returning, avoiding an invalid raw slice. The deque helper also
propagates `ReleaseBuffer` errors instead of panicking.
