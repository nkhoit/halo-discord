from tools.xiso_extract import Entry, Image, _copy_entry


def test_copy_entry_preserves_newline_bytes(tmp_path):
    # Compressed map data contains every byte value; a text-mode descriptor on
    # Windows would expand each 0x0A into 0x0D 0x0A.
    payload = bytes(range(256)) * 16 + b"\n\r\n\n"
    image_path = tmp_path / "disc.iso"
    image_path.write_bytes(payload)
    destination = tmp_path / "out.map"

    with Image(image_path) as image:
        _copy_entry(image, Entry("out.map", 0, len(payload), False), destination)

    assert destination.read_bytes() == payload
