import sys
from pathlib import Path
from sanitize import sanitize_text

p = Path(sys.argv[1])
p.write_text(sanitize_text(p.read_text()))
