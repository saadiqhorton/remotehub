"""Copy regular guest artifacts without letting guest paths modify host resources."""
import sys
import tarfile
from pathlib import Path, PurePosixPath


def extract(archive, destination):
    with tarfile.open(archive) as source:
        members = source.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            allowed = {"clean-install-shots", "compose-acceptance-shots", "desktop-logs"}
            if (path.is_absolute() or ".." in path.parts or
                    not (path.parts and (path.parts[0] in allowed or
                         member.name in {"server.log", "ssh-server.log", "ci/summary"}))):
                raise ValueError(f"Unexpected artifact path: {member.name}")
            if not (member.isfile() or member.isdir()):
                raise ValueError(f"Unsupported artifact type: {member.name}")
            # Also reject a pre-existing destination symlink escaping the workspace.
            tarfile.data_filter(member, str(destination))
        source.extractall(destination, members=members, filter="data")


if __name__ == "__main__":
    extract(sys.argv[1], Path(sys.argv[2]).resolve())
