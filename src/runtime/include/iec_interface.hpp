// SPDX-License-Identifier: GPL-3.0-or-later WITH STruCpp-runtime-exception
// Copyright (C) 2025 Autonomy / OpenPLC Project
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - IEC Interface References
 *
 * An IEC 61131-3 / CODESYS interface variable is a nullable reference to a
 * function block instance, not an embedded value. Before the first
 * assignment (`itf := fb`) or a successful `__QUERYINTERFACE` it is
 * unbound. Generated method calls guard with get() so an unbound call
 * yields the method's zero value instead of dereferencing null — the PLC
 * task must survive a bad program, never crash.
 *
 * All operations are a single pointer copy or compare: no allocation, no
 * exceptions, no logging, safe on the real-time path.
 *
 * Example ST code:
 *   VAR
 *       itf : IAct;
 *       fb  : Provider;   // FUNCTION_BLOCK Provider IMPLEMENTS IAct
 *   END_VAR
 *   itf := fb;            // bind
 *   y := itf.Go();        // virtual dispatch through the reference
 *   ok := __QUERYINTERFACE(fb, itf);
 *
 * Generated C++:
 *   IEC_ITF<IACT> itf;
 *   PROVIDER fb;
 *   itf.bind(fb);
 *   y = (itf.get() != nullptr ? itf->Go() : 0);
 */

#pragma once

#include <cstddef>
#include <type_traits>

namespace strucpp {

/**
 * Nullable reference to a function block instance accessed through one of
 * its interfaces. `T` is the generated abstract class of the interface.
 */
template <typename T>
class IEC_ITF {
public:
    IEC_ITF() : ptr_(nullptr) {}
    IEC_ITF(const IEC_ITF&) = default;
    IEC_ITF& operator=(const IEC_ITF&) = default;
    ~IEC_ITF() = default;

    /**
     * Bind an instance while constructing a temporary. A property setter
     * takes `const IEC_ITF<T>&`, so passing a function block builds that
     * temporary for the call. Copy construction of another IEC_ITF stays
     * on the copy constructor: U* is not convertible to T*.
     */
    template <typename U,
              typename = typename std::enable_if<
                  std::is_convertible<U*, T*>::value &&
                  !std::is_same<typename std::decay<U>::type, IEC_ITF>::value>::type>
    IEC_ITF(U& instance) : ptr_(&instance) {}

    /**
     * Bind to an instance. `U` must derive from `T` (or be `T` itself) —
     * enforced at compile time, so a program the analyzer accepted always
     * upcasts soundly. Accepts a pointer too: nullptr unbinds, which is
     * how a failed __QUERYINTERFACE releases the previous instance.
     */
    template <typename U,
              typename = typename std::enable_if<
                  std::is_convertible<U*, T*>::value>::type>
    void bind(U& instance) {
        ptr_ = &instance;
    }

    template <typename U,
              typename = typename std::enable_if<
                  std::is_convertible<U*, T*>::value>::type>
    void bind(U* instance) {
        ptr_ = instance;
    }

    /** Raw interface pointer; nullptr when unbound. */
    T* get() const { return ptr_; }

    /** Dispatch access — guarded by get() != nullptr at call sites. */
    T* operator->() const { return ptr_; }

    /** True when the reference is bound (one pointer compare). */
    bool bound() const { return ptr_ != nullptr; }

    explicit operator bool() const { return ptr_ != nullptr; }

private:
    T* ptr_;
};

}  // namespace strucpp
