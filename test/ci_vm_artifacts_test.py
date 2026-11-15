import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("artifacts", Path(__file__).resolve().parents[1] / "deploy/ci-vm-artifacts.py")
artifacts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifacts)


class ArtifactSafety(unittest.TestCase):
    def archive(self, root, name, kind=tarfile.REGTYPE, linkname=""):
        archive = root / "guest.tar"
        with tarfile.open(archive, "w") as output:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = linkname
            data = b"evidence"
            member.size = len(data) if kind == tarfile.REGTYPE else 0
            output.addfile(member, io.BytesIO(data) if member.size else None)
        return archive

    def test_regular_evidence_is_copied(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "out"
            destination.mkdir()
            artifacts.extract(self.archive(root, "desktop-logs/guacd.log"), destination)
            self.assertEqual((destination / "desktop-logs/guacd.log").read_bytes(), b"evidence")

    def test_escape_links_devices_and_repo_files_are_rejected(self):
        for name, kind, target in [
            ("../precious", tarfile.REGTYPE, ""),
            ("/tmp/precious", tarfile.REGTYPE, ""),
            ("deploy/ci-vm.sh", tarfile.REGTYPE, ""),
            ("desktop-logs/link", tarfile.SYMTYPE, "../../precious"),
            ("desktop-logs/link", tarfile.LNKTYPE, "server.log"),
            ("desktop-logs/device", tarfile.CHRTYPE, ""),
        ]:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                destination = root / "out"
                destination.mkdir()
                with self.assertRaises(ValueError):
                    artifacts.extract(self.archive(root, name, kind, target), destination)
                self.assertEqual(list(destination.iterdir()), [])

    def test_existing_host_symlink_cannot_redirect_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "out"
            destination.mkdir()
            other = root / "other-project"
            other.mkdir()
            (destination / "desktop-logs").symlink_to(other, target_is_directory=True)
            with self.assertRaises(tarfile.FilterError):
                artifacts.extract(self.archive(root, "desktop-logs/guacd.log"), destination)
            self.assertEqual(list(other.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
