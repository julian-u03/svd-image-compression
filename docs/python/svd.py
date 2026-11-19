"""Direct, educational Golub--Reinsch SVD: Householder + bidiagonal QR.

No Gram matrix or library decomposition is used. NumPy supplies only array
arithmetic. The QR case distinctions follow the public-domain JAMA/LINPACK
reference; see the repository README for attribution and numerical limits.
"""

from math import copysign, hypot, sqrt

import numpy as np


def _reflector(vector):
    """Return v, beta, alpha with (I - beta vv.T) x = alpha e_1.

    Scaling first avoids squaring very large/small input entries. Choosing the
    opposite sign for alpha avoids cancellation in the first reflector entry.
    """
    scale = float(np.max(np.abs(vector)))
    if scale == 0:
        return None, 0.0, 0.0
    v = vector / scale
    length = sqrt(float(v @ v))
    sign = copysign(1.0, float(v[0]))
    alpha = -sign * length * scale
    v /= length
    v[0] += sign
    beta = 2.0 / float(v @ v)
    return v, beta, alpha


def bidiagonalize(matrix, progress=lambda message: None):
    """For m >= n, return thin U, d, e, V with A = U B V.T.

    B is n x n upper bidiagonal. e has a final zero sentinel. Reflectors are
    stored as vectors, never as full m x m transformation matrices. Thin bases
    are accumulated backwards after reduction, avoiding a full left basis.
    """
    a = np.array(matrix, dtype=np.float64, copy=True)
    m, n = a.shape
    left, right = [], []
    diagonal = np.zeros(n)
    upper = np.zeros(n)
    for k in range(n):
        v, beta, alpha = _reflector(a[k:, k])
        left.append((v, beta))
        if v is not None:
            block = a[k:, k + 1:]
            block -= np.outer(v, beta * (v @ block))
        diagonal[k] = alpha
        if k + 1 < n:
            v, beta, alpha = _reflector(a[k, k + 1:])
            right.append((v, beta))
            if v is not None:
                block = a[k + 1:, k + 1:]
                block -= np.outer(beta * (block @ v), v)
            upper[k] = alpha
        if k % max(1, n // 20) == 0:
            progress(f"Householder reduction · {k + 1}/{n}…")

    # Column-major bases make the later Givens column updates contiguous.
    u = np.eye(m, n, dtype=np.float64, order="F")
    v_basis = np.eye(n, dtype=np.float64, order="F")
    for k in range(n - 1, -1, -1):
        v, beta = left[k]
        if v is not None:
            block = u[k:, k:]
            block -= np.outer(v, beta * (v @ block))
        if k < len(right):
            v, beta = right[k]
            if v is not None:
                block = v_basis[k + 1:, k + 1:]
                block -= np.outer(v, beta * (v @ block))
    return u, diagonal, upper, v_basis


def _givens(first, second):
    radius = hypot(first, second)
    if radius == 0:
        return 1.0, 0.0, 0.0
    return first / radius, second / radius, radius


def _rotate_columns(basis, first, second, cosine, sine):
    """Accumulate the same orthogonal rotation in a singular-vector basis."""
    old_first = basis[:, first].copy()
    old_second = basis[:, second].copy()
    basis[:, first] = cosine * old_first + sine * old_second
    basis[:, second] = -sine * old_first + cosine * old_second


def diagonalize_bidiagonal(u, diagonal, upper, v, max_iterations=100,
                          progress=lambda message: None):
    """Implicit shifted QR with Givens rotations, splitting and deflation.

    Only the diagonal/superdiagonal are stored. The shift uses a few scalar
    products from the trailing 2 x 2 problem; neither A.T@A nor B.T@B is formed.
    A failed iteration limit raises an error instead of returning partial data.
    """
    d, e = diagonal.copy(), upper.copy()
    active = len(d)
    epsilon = np.finfo(np.float64).eps
    tiny = np.finfo(np.float64).tiny / epsilon
    attempts = 0
    while active:
        # Locate a negligible superdiagonal separating independent subproblems.
        split = active - 2
        while split >= 0:
            if abs(e[split]) <= tiny + epsilon * (abs(d[split]) + abs(d[split + 1])):
                e[split] = 0.0
                break
            split -= 1
        if split == active - 2:
            # One singular value has converged. Fix its sign in V, then deflate.
            index = active - 1
            if d[index] < 0:
                d[index] = -d[index]
                v[:, index] *= -1
            active -= 1
            attempts = 0
            if active % max(1, len(d) // 20) == 0:
                progress(f"Bidiagonal QR · {len(d) - active}/{len(d)} values converged…")
            continue

        # A zero diagonal needs a zero-chasing step rather than a shifted step.
        zero = active - 1
        while zero > split:
            neighbors = (abs(e[zero]) if zero < active - 1 else 0.0)
            if zero > split + 1:
                neighbors += abs(e[zero - 1])
            if abs(d[zero]) <= tiny + epsilon * neighbors:
                d[zero] = 0.0
                break
            zero -= 1
        start = split + 1
        attempts += 1
        if attempts > max_iterations:
            raise ArithmeticError("Bidiagonal QR did not converge. Try a lower resolution.")

        if zero == active - 1:
            # Remove a trailing zero using right rotations.
            f = e[active - 2]
            e[active - 2] = 0.0
            for j in range(active - 2, start - 1, -1):
                c, s, d[j] = _givens(d[j], f)
                if j != start:
                    f, e[j - 1] = -s * e[j - 1], c * e[j - 1]
                _rotate_columns(v, j, active - 1, c, s)
        elif zero > split:
            # Split at an interior zero using left rotations.
            start = zero + 1
            f = e[start - 1]
            e[start - 1] = 0.0
            for j in range(start, active):
                c, s, d[j] = _givens(d[j], f)
                f, e[j] = -s * e[j], c * e[j]
                _rotate_columns(u, j, start - 1, c, s)
        else:
            # A scaled Wilkinson-style shift starts the implicit QR sweep.
            scale = max(abs(d[active - 1]), abs(d[active - 2]),
                        abs(e[active - 2]), abs(d[start]), abs(e[start]))
            last, previous = d[active - 1] / scale, d[active - 2] / scale
            edge, first, first_edge = e[active - 2] / scale, d[start] / scale, e[start] / scale
            b = ((previous + last) * (previous - last) + edge * edge) / 2
            product = (last * edge) ** 2
            shift = product / (b + copysign(hypot(b, sqrt(product)), b)) if product else 0.0
            f = (first + last) * (first - last) + shift
            g = first * first_edge
            for j in range(start, active - 1):
                c, s, radius = _givens(f, g)
                if j != start:
                    e[j - 1] = radius
                f, e[j] = c * d[j] + s * e[j], c * e[j] - s * d[j]
                g, d[j + 1] = s * d[j + 1], c * d[j + 1]
                _rotate_columns(v, j, j + 1, c, s)
                c, s, d[j] = _givens(f, g)
                f, d[j + 1] = c * e[j] + s * d[j + 1], -s * e[j] + c * d[j + 1]
                g, e[j + 1] = s * e[j + 1], c * e[j + 1]
                _rotate_columns(u, j, j + 1, c, s)
            e[active - 2] = f

    order = np.argsort(-d, kind="stable")
    return u[:, order], d[order], v[:, order].T


def compute_svd(matrix, progress=lambda message: None, max_iterations=100):
    """Return the complete thin SVD (U, s, Vt) of a real matrix.

    Wide matrices are transposed once; swapping the resulting bases restores the
    original orientation. Scaling protects the reduction from overflow. Small
    singular values are retained, rather than discarded by a Gram threshold.
    """
    a = np.asarray(matrix, dtype=np.float64)
    if a.ndim != 2 or min(a.shape) < 1 or not np.all(np.isfinite(a)):
        raise ValueError("Expected a nonempty finite real matrix.")
    scale = float(np.max(np.abs(a)))
    transposed = a.shape[0] < a.shape[1]
    work = (a.T if transposed else a) / (scale or 1.0)
    u, d, e, v = bidiagonalize(work, progress)
    u, s, vt = diagonalize_bidiagonal(u, d, e, v, max_iterations, progress)
    s *= scale
    if transposed:
        u, vt = vt.T, u.T
    return u, s, vt


def reconstruct(factors, rank):
    """Reconstruct in floating point; clipping would invalidate error checks."""
    u, s, vt = factors
    return (u[:, :rank] * s[:rank]) @ vt[:rank, :]


def relative_error(matrix, approximation):
    norm = float(np.linalg.norm(matrix))
    return float(np.linalg.norm(matrix - approximation) / norm) if norm else 0.0


def recommend_rank(matrix, factors, error_limit=0.05):
    """Use Eckart--Young tail energy, then verify the measured error boundary.

    Reverse cumulative sums avoid subtracting two nearly equal total energies.
    The candidate and predecessor are checked on unclipped reconstructions. This
    avoids binary-search reconstruction costs while retaining the measured rule.
    """
    s = factors[1]
    norm = float(np.linalg.norm(matrix))
    if norm == 0:
        return 1, 0.0, np.zeros_like(matrix)
    tail = np.append(np.cumsum((s[::-1] / norm) ** 2)[::-1], 0.0)
    rank = max(1, int(np.searchsorted(-tail, -error_limit ** 2)))
    rank = min(rank, len(s))
    approximation = reconstruct(factors, rank)
    error = relative_error(matrix, approximation)
    while error > error_limit and rank < len(s):
        rank += 1
        approximation = reconstruct(factors, rank)
        error = relative_error(matrix, approximation)
    while rank > 1:
        previous = reconstruct(factors, rank - 1)
        previous_error = relative_error(matrix, previous)
        if previous_error > error_limit:
            break
        rank, error, approximation = rank - 1, previous_error, previous
    if error > error_limit:
        raise ArithmeticError("The SVD could not satisfy the requested error limit.")
    return rank, error, approximation
